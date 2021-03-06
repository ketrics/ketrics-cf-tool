const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const archiver = require('archiver');
const AWS = require('aws-sdk');
const flatten = require('flat');
const util = require('util')
// Custom Resources Handlers
const {Cognito} = require('./Cognito.class');
const {Lambda} = require('./Lambda.class');

// Set the API version globally
AWS.config.update({region: 'us-east-1'});
AWS.config.apiVersions = {s3: '2006-03-01'};

const defaults = {
    templatePath: './node_modules/ketrics-cf/templates',
    projectParametersFilename: './stacks/parameters.json'
}

const fileVariableSyntax = RegExp(/\${file\((.*?)\)/g);
const variableSyntax = RegExp(/\${(.*?)}/g);

module.exports.CloudFormationGenerator = class {

    constructor(templatePath, projectParametersFilename){
        this.templatePath = templatePath || defaults.templatePath;
        this.projectParametersFilename = projectParametersFilename || defaults.projectParametersFilename;
    }

    runCmd(cmd){
        console.log(`cmd: ${cmd}`);
        exec(cmd, (err, stdout, stderr) => {
            if (err) {
              // node couldn't execute the command
              if(stderr){
                  console.log(`stderr:`);
                  console.log(stderr);
              }
            }
          
            // the *entire* stdout and stderr (buffered)
            if(stdout){
                console.log(`stdout:`);
                console.log(stdout);
            }
          });
    }
    
    async createProjectDeploymentBucket(){
        const {projectDeploymentBucketName} = this.parameters;
        try{
            // Create S3 service object
            const s3 = new AWS.S3();
            const {Buckets} = await s3.listBuckets().promise();
            const index = Buckets.findIndex(bucket=>{
                return bucket.Name == projectDeploymentBucketName;
            });

            if(index > -1){
                console.log(`Bucket ${projectDeploymentBucketName} already exists!`);
            }else{
                let params = {
                    Bucket : projectDeploymentBucketName
                };
                await s3.createBucket(params).promise();

                params = {
                    Bucket: projectDeploymentBucketName,
                    ServerSideEncryptionConfiguration: {
                      Rules: [
                        {
                          ApplyServerSideEncryptionByDefault: {
                            SSEAlgorithm: 'AES256'
                          }
                        }
                      ]
                    }
                };
                await s3.putBucketEncryption(params).promise();

                console.log(`Bucket ${projectDeploymentBucketName} created!`);
            }
            
        }catch(err){
            console.log(err);
            throw err;
        }
    }

    async uploadFileToDeploymentBucket({bucketKey, filename}){
        const {projectDeploymentBucketName} = this.parameters;
        try{
            const fileContent = fs.readFileSync(filename);
            
            // call S3 to retrieve upload file to specified bucket
            const s3 = new AWS.S3();
            const params = {
                Bucket: projectDeploymentBucketName,
                Body: fileContent,
                Key: bucketKey
            };
            const data = await s3.upload(params).promise();
            console.log("File uploaded:", data);
            return data;
        }catch(err){
            throw err;
        }
    }

    async uploadLambdaToDeploymentBucket(){
        try{
            console.log("Uploading Lambda Code");
            await this.uploadFileToDeploymentBucket({
                filename: this.parameters.lambdaCodeFilename,
                bucketKey: this.parameters.lambdaCodeBucketKey
            })
        }catch(err){
            console.log(err);
            throw err;
        }
    }

    async uploadStackTemplateToDeploymentBucket(){
        try{
            const params = {
                filename: this.parameters.stackTemplateFilename,
                bucketKey: this.parameters.stackTemplateBucketKey
            };
            console.log(`Uploading Stack Template:`, params);
            const data = await this.uploadFileToDeploymentBucket(params);
            this.templateUrl = data.Location;
        }catch(err){
            console.log(err);
            throw err;
        }
    }

    async getStack(){
        try{
            const cloudformation = new AWS.CloudFormation();
            const params = {
                StackName: this.stackName
            }
            const {Stacks} = await cloudformation.describeStacks(params).promise();
            return Stacks[0];
        }catch(err){
            return null;
        }
    }

    async deployStack(stack){
        try{
            let d = new Date();
            let params = {
                StackName: this.stackName,
                Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
                TemplateURL: this.templateUrl,
                Tags: []
            };

            const cloudformation = new AWS.CloudFormation();
            let data;
            if(stack){
                params.Tags = [
                    ...stack.Tags,
                    {
                        Key: 'updatedBy',
                        Value: 'ketrics-cf'
                    },
                    {
                        Key: 'updatedAt',
                        Value: d.toISOString()
                    }, 
                ];
                console.log(`Updating stack ${this.stackName}`, params);
                data = await cloudformation.updateStack(params).promise();
                console.log(data);

                // Wait to get Stack Description
                params = {StackName: this.stackName};
                await cloudformation.waitFor('stackUpdateComplete', params).promise();
            }else{
                params.Tags = [
                    {
                        Key: 'createdBy',
                        Value: 'ketrics-cf'
                    },
                    {
                        Key: 'createdAt',
                        Value: d.toISOString()
                    }, 
                ];
                console.log(`Creating stack ${this.stackName}`, params);
                data = await cloudformation.createStack(params).promise();
                console.log(data);

                // Wait to get Stack Description
                params = {StackName: this.stackName};
                await cloudformation.waitFor('stackCreateComplete', params).promise();
            }
            const stackInfo = await this.syncStack();
            console.log(stackInfo);
            return data;
        }catch(err){
            console.log(err);
            throw err;
        }
    }

    async syncStack(){
        try{
            const response = await this.getStack();
            const stackInfo = {
                stackName: response.StackName,
                stackId: response.StackId,
                description: response.Description,
                outputs: response.Outputs.reduce((obj, output)=>{
                    obj[output.OutputKey] = output.OutputValue;
                    return obj;
                }, {}),
                stackStatus: response.StackStatus
            };
            this.updateStackParameters(stackInfo);
            return stackInfo;
        }catch(err){
            throw err;
        }
    }

    updateStackParameters(newStackInfo){
        let buildParameters = this.loadJsonFile("build/parameters.json");
        buildParameters.stacks = buildParameters.stacks || {};
        let currentStackInfo = buildParameters.stacks[this.stackId] || {};
        if(newStackInfo){
            if(this.stackId)
                buildParameters.stacks[this.stackId] = {
                    ...currentStackInfo,
                    ...newStackInfo
                };
        }else{
            delete buildParameters.stacks[this.stackId];
        }

        fs.writeFileSync("build/parameters.json", JSON.stringify(buildParameters, null, 4));
        return buildParameters;
    }

    updateProjectParameters(projectParameters){
        let buildParameters = this.loadJsonFile("build/parameters.json");
        buildParameters = {
            ...buildParameters,
            ...projectParameters
        }
        fs.writeFileSync("build/parameters.json", JSON.stringify(buildParameters, null, 4));
        return buildParameters;
    }

    async updateLambdaCode(){
        try{
            const lambda = new AWS.Lambda();
            const params = {
                FunctionName: this.parameters.functionName, 
                Publish: true, 
                S3Bucket: this.parameters.projectDeploymentBucketName, 
                S3Key: this.parameters.lambdaCodeBucketKey 
            };

            const response = await lambda.updateFunctionCode(params).promise();
            console.log(response);
        }catch(err){
            throw err;
        }
    }

    async deleteStack(stack){
        if(stack){
            try{
                let params = {
                    StackName: this.stackName
                };

                const cloudformation = new AWS.CloudFormation();
                console.log(`Deleting stack ${this.stackName}`);
                const data = await cloudformation.deleteStack(params).promise();
                console.log(data);
            }catch(err){
                console.log(err);
                throw err;
            }
        }else{
            console.log(`The stack ${this.stackName} doesn't exist`);
        }
        this.updateStackParameters(null);
    }

    loadArgs(){
        const argvs = JSON.parse(process.env.npm_config_argv);
        const [cmd, script, ...args] = argvs.original;
        const paramKeys = {
            "-t": "template",
            "-template": "template",
            "-s": "stackFolder",
            "-stack": "stackFolder"
        }

        let parameters = args
            .filter(arg=>arg.match(/^-/))
            .reduce((obj, arg)=>{
                const index = args.indexOf(arg);
                const key = paramKeys[arg] || arg.substring(1);
                obj[key] = args[index+1];
                return obj;
            }, {});
        
        if(parameters.stackFolder && parameters.stackFolder.match(/\/$/))
            parameters.stackFolder = parameters.stackFolder.slice(0,-1);


        console.log("Command line arguments:", parameters);

        return {
            cmd,
            script,
            argvs,
            args: parameters
        }
    }

    async handle(){
        let stackInfo;
        const {cmd, script, args, argvs} = this.loadArgs();

        if(cmd==='run'){
            this.loadStackParameters(args.stackFolder);
            const {stackType} = this.parameters;
            // Set the region
            AWS.config.update({region: this.parameters["AWS::Region"]});
            
            switch(script){
                case "build":
                    console.log(util.inspect(this.parameters, {showHidden: false, depth: null}));
                    await this.processStack();
                    break;
                case "test":
                    console.log(util.inspect({cmd, script, args, argvs, parameters: this.parameters}, {showHidden: false, depth: null}));
                    break;
                case "describe":
                    stackInfo = await this.getStack();
                    console.log("stackInfo", stackInfo);
                    break;
                case "upload":
                    await this.uploadStackTemplateToDeploymentBucket();
                    break;
                case "sync":
                    // Upload Stack template to Project Bucket
                    stackInfo = await this.syncStack();
                    console.log(stackInfo);
                    break;
                case "update-code":
                    // Create the Stack template replacing the parameters and files
                    await this.processStack();

                    // Upload Lambda code to Project Bucket
                    if(stackType==="AWS_LAMBDA"){
                        await this.uploadLambdaToDeploymentBucket();
                        await this.updateLambdaCode();
                    }
                    break;
                default:
                    // Creates Project Bucket to upload Stacks files
                    await this.createProjectDeploymentBucket();

                    // Gets the Stack if it is already deployed
                    const stack = await this.getStack();

                    switch(script){
                        case "deploy":
                            // Create the Stack template replacing the parameters and files
                            await this.processStack();
                                
                            // Upload Stack template to Project Bucket
                            await this.uploadStackTemplateToDeploymentBucket();

                            // Upload Lambda code to Project Bucket
                            if(stackType==="AWS_LAMBDA")
                                await this.uploadLambdaToDeploymentBucket();

                            // Deploy Stack
                            await this.deployStack(stack);
                            break;
                        case "remove":
                            await this.deleteStack(stack);
                            break;
                        case "create":
                            const {template} = args;
                            if(stack){
                                console.log(`Stack ${this.stackName} already exist`);
                            }else if(template){
                                this.createStackFromTemplate(template);
                            }else{
                                console.log(`Please provide a valid template`)
                            }
                            break;
                        default:
                            console.log(`Unhandled script ${script}`);
                            break;
                    }
                    break;
            }
        }
    }

    createStackFromTemplate(template){
        if(this.stackFolder && template){
            const source = `${this.templatePath}/${template}`;
            const target = `./${this.stackFolder}`;
    
            if ( fs.existsSync( target ) ) {
                console.log(`There is already a Stack named: ${this.stackFolder}`);
            }else{
                console.log(`Creating Stack: ${this.stackFolder} from template ${template}`);
                this.copyFolderRecursiveSync(source, target);
            }
        }else{
            console.log(`You must define the stackName and the template`);
        }
    }

    copyFileSync( source, target ) {
        var targetFile = target;
    
        //if target is a directory a new file with the same name will be created
        if ( fs.existsSync( target ) ) {
            if ( fs.lstatSync( target ).isDirectory() ) {
                targetFile = path.join( target, path.basename( source ) );
            }
        }
    
        fs.writeFileSync(targetFile, fs.readFileSync(source));
    }

    copyFolderRecursiveSync( source, target ) {
        var files = [];
    
        //check if folder needs to be created or integrated
        var targetFolder = target;
        if ( !fs.existsSync( targetFolder ) ) {
            fs.mkdirSync( targetFolder );
        }
    
        //copy
        if ( fs.lstatSync( source ).isDirectory() ) {
            files = fs.readdirSync( source );
            files.forEach(file =>{
                const curSource = path.join( source, file );
                if ( fs.lstatSync( curSource ).isDirectory() ) {
                    const curTarget = path.join(targetFolder, file);
                    this.copyFolderRecursiveSync( curSource, curTarget );
                } else {
                    this.copyFileSync( curSource, targetFolder );
                }
            } );
        }
    }

    createLambdaZip(){
        return new Promise((resolve, reject) => {
            console.log("Creating Lambda Zip file");
            const output = fs.createWriteStream(this.parameters.lambdaCodeFilename);
            const archive = archiver('zip');

            output.on('close',()=>{
                console.log(archive.pointer() + ' total bytes');
                console.log(`Lambda Zip file created:`, {filename: this.parameters.lambdaCodeFilename});
                resolve(this.parameters.lambdaCodeFilename);
            });
            
            archive.on('error',(err)=>{
                reject(err);
            });
            
            archive.pipe(output);           
            archive.glob(`**`, 
                {
                    cwd: `./${this.stackFolder}`,
                    ignore: [
                        `parameters.json`, 
                        `template.yml`
                    ]
                }
            );
            archive.finalize();
        });
    }

    loadJsonFile(filename, variables={}){
        try{
            let fileContent = fs.readFileSync(filename, 'utf8');
            fileContent = this.replaceVariables(fileContent, variables)
            return JSON.parse(fileContent);
        }catch(err){
            console.log(`${filename} does not exist!`);
            return {};
        }
    }

    loadStackParameters(stackFolder){
        this.stackFolder = stackFolder;
        // Load Project Parameters to replace into Stack Parameters before loading them
        let projectParameters = this.loadJsonFile(this.projectParametersFilename);
        // Save Project parameters
        let buildParameters = this.updateProjectParameters(projectParameters);

        // Load stack parameters replacing project parameters if founded
        const stackParameters = this.loadJsonFile(`./${stackFolder}/parameters.json`, buildParameters);
        this.stackId = stackParameters.stackId;

        // Save stack parameters and get buildParameters
        buildParameters = this.updateStackParameters({parameters: stackParameters});

        // Create stack name with the projectName
        this.stackName = `${buildParameters.projectName}-${this.stackId}`;
        
        this.parameters = {
            ...buildParameters,
            ...stackParameters,
            stackName: this.stackName,
            stackFolder: this.stackFolder,
            stackId: this.stackId,
            stackTemplateFilename: path.join('./build', `${this.stackName}.yml`),
            stackTemplateBucketKey: `${this.stackFolder}/${this.stackName}.yml`,
            projectDeploymentBucketName: `${buildParameters.projectName.toLowerCase()}-deploymentbucket`
        }

        // Cognito Parameters
        if(this.parameters.stackType==="AWS_COGNITO")
            Cognito.loadParameters(this.parameters);
        
        // Lambda Parameters
        if(this.parameters.stackType==="AWS_LAMBDA")
            Lambda.loadParameters(this.parameters);
    }

    async processStack(template="template.yml"){   
        const {stackType} = this.parameters;     
        const tplFilename = `./${this.stackFolder}/${template}`;
        console.log("Processing Stack Template file:", {filename: tplFilename});
        let templateContent = fs.readFileSync(tplFilename, 'utf8');
        templateContent = this.replaceVariables(templateContent, this.parameters);
        templateContent = this.replaceFiles(templateContent);

        // Create Stack Template Output
        fs.writeFileSync(this.parameters.stackTemplateFilename, templateContent);
        console.log("The Stack Template was saved:",{filename: this.parameters.stackTemplateFilename});

        // If the Stack is an AWS_LAMBDA then zip the files and upload it to the Project Bucket
        if(stackType==="AWS_LAMBDA"){
            // Create Zip file with Lambda code
            await this.createLambdaZip();
        }
    }

    replaceVariables(template, variables){
        template = template.replace(new RegExp(/\${file\(/g), '$[file(');
        const flattenVariables = flatten(variables);
        const configVariables = Object.keys(flattenVariables);
        const templateVariables = [];
        let searchResult;
        // eslint-disable-next-line no-cond-assign
        while ((searchResult = variableSyntax.exec(template)) !== null) {
          templateVariables.push(searchResult[1]);
        }

        const substitutions = configVariables
            .filter(value => templateVariables.indexOf(value) > -1)
            .filter((value, index, array) => array.indexOf(value) === index)
            .reduce(
                (accum, value) => Object.assign(accum, { [value]: flattenVariables[value] }),
                {},
            );

        let variablesKeys = Object.keys(substitutions).join('|');
        let regex = new RegExp("\\${(" + variablesKeys + ")}", "g");
        template = template.replace(regex, "|||$1|||");

        let templateJoin = template.split('|||');

        for (let i = 0; i < templateJoin.length; i++) {
            if (substitutions.hasOwnProperty(templateJoin[i])) {
                templateJoin[i] = substitutions[templateJoin[i]];
            }
        }
        template = templateJoin.join('');
        template = template.replace(new RegExp(/\$\[file\(/g), '${file(');
        return template;
    }

    replaceFiles(template){
        
        const fileTemplateVariables = [];
        let searchResult;
        // eslint-disable-next-line no-cond-assign
        while ((searchResult = fileVariableSyntax.exec(template)) !== null) {
            fileTemplateVariables.push(searchResult[1]);
        }

        fileTemplateVariables.forEach(filename=>{
            let content = fs.readFileSync(filename, 'utf8');
            content = content.replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\"/g, "\\\"");
            const search = "${file("+filename+")}";
            template = template.split(search).join(content);
        })
        return template;
    }
}