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

const defaults = {
    templatePath: './node_modules/ketrics-cf/templates',
    projectParametersFilename: './stacks/parameters.json'
}

module.exports.CloudFormationGenerator = class {

    constructor(templatePath, projectParametersFilename){
        this.templatePath = templatePath || defaults.templatePath;
        this.projectParametersFilename = projectParametersFilename || defaults.projectParametersFilename;
    }

    get stackTemplateFilename(){
        return path.join('./build', `${this.stackName}.yml`);
    }

    get stackTemplateBucketKey(){
        return `${this.stackName}/${this.stackName}.yml`;
    }

    loadJsonFile(filename){
        try{
            return JSON.parse(fs.readFileSync(filename, 'utf8'));
        }catch(err){
            console.log(`${filename} does not exist!`);
            return {};
        }
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
            const s3 = new AWS.S3({apiVersion: '2006-03-01'});
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
            const s3 = new AWS.S3({apiVersion: '2006-03-01'});
            const params = {
                Bucket: projectDeploymentBucketName,
                Body: fileContent,
                Key: bucketKey
            };
            const data = await s3.upload(params).promise();
            console.log("File uploaded:");
            console.log(data);
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
            console.log("Uploading Stack Template");
            const data = await this.uploadFileToDeploymentBucket({
                filename: this.stackTemplateFilename,
                bucketKey: this.stackTemplateBucketKey
            });
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
                    {
                        Key: 'updatedBy',
                        Value: 'ketrics-cf'
                    },
                    {
                        Key: 'updatedAt',
                        Value: d.toISOString()
                    }, 
                ];
                console.log(`Updating stack ${this.stackName}`);
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
                console.log(`Creating stack ${this.stackName}`);
                data = await cloudformation.createStack(params).promise();
                console.log(data);

                // Wait to get Stack Description
                params = {StackName: this.stackName};
                await cloudformation.waitFor('stackCreateComplete', params).promise();
            }
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
            console.log(stackInfo);
            this.updateProjectStackParameters(stackInfo);
            
            return data;
        }catch(err){
            console.log(err);
            throw err;
        }
    }

    updateProjectStackParameters(newStackInfo){
        let projectParameters = this.loadJsonFile(this.projectParametersFilename);
        projectParameters.stacks = projectParameters.stacks || {};
        let currentStackInfo = projectParameters.stacks[this.stackName] || {};
        if(newStackInfo){
            projectParameters.stacks[this.stackName] = {
                ...currentStackInfo,
                ...newStackInfo
            };
        }else{
            delete projectParameters.stacks[this.stackName];
        }

        fs.writeFileSync(this.projectParametersFilename, JSON.stringify(projectParameters, null, 4));
        return projectParameters;
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
                return data;
            }catch(err){
                console.log(err);
                throw err;
            }
        }else{
            console.log(`The stack ${this.stackName} doesn't exist`);
        }
        this.updateProjectStackParameters(null);
    }

    loadArgs(){
        const argvs = JSON.parse(process.env.npm_config_argv);
        const [cmd, script, ...args] = argvs.original;
        const paramKeys = {
            "-t": "template",
            "-template": "template",
            "-s": "stackName",
            "-stack": "stackName"
        }

        let parameters = args
            .filter(arg=>arg.match(/^-/))
            .reduce((obj, arg)=>{
                const index = args.indexOf(arg);
                if(paramKeys[arg]){
                    obj[paramKeys[arg]] = args[index+1];
                }else{
                    obj[arg.substring(1)] = args[index+1];
                }
                
                return obj;
            }, {});
        
        console.log("Command line arguments:", parameters);

        return {
            cmd,
            script,
            argvs,
            args: parameters
        }
    }

    async handle(){
        const {cmd, script, args, argvs} = this.loadArgs();

        if(cmd==='run'){
            this.stackName = args.stackName;
            this.loadStackParameters();
            const {AwsRegion, stackType} = this.parameters;
            // Set the region
            AWS.config.update({region: AwsRegion});
            
            if(script==="build"){
                console.log(util.inspect(this.parameters, {showHidden: false, depth: null}));
                await this.processStack();
            }if(script==="test"){
                console.log(util.inspect({cmd, script, args, argvs, parameters: this.parameters}, {showHidden: false, depth: null}));
            }if(script==="describe"){
                this.getStack();
            }else {
                // Gets the Stack if it is already deployed
                const stack = await this.getStack();

                if(script==="deploy"){
                    // Creates Project Bucket to upload Stacks files
                    await this.createProjectDeploymentBucket();

                    // Create the Stack template replacing the parameters and files
                    await this.processStack();

                    // Upload Stack template to Project Bucket
                    await this.uploadStackTemplateToDeploymentBucket();

                    // Upload Lambda code to Project Bucket
                    if(stackType==="AWS_LAMBDA")
                        await this.uploadLambdaToDeploymentBucket();
                    
                    // Deploy Stack
                    await this.deployStack(stack);

                }else if(script==="remove"){
                    // Deploy Stack
                    await this.deleteStack(stack);
                }else if(script==="create"){
                    const {template} = args;
                    if(stack){
                        console.log(`Stack ${this.stackName} already exist`);
                    }else{
                        this.createStackFromTemplate(template);
                    }
                }
            }
        }
    }

    createStackFromTemplate(template){
        if(this.stackName && template){
            const source = `${this.templatePath}/${template}`;
            const target = `./stacks/${this.stackName}`;
    
            if ( fs.existsSync( target ) ) {
                console.log(`There is already a Stack named: ${this.stackName}`);
            }else{
                console.log(`Creating Stack: ${this.stackName} from template ${template}`);
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
                console.log(`Zip file created: ${this.parameters.lambdaCodeFilename}`);
                resolve(this.parameters.lambdaCodeFilename);
            });
            
            archive.on('error',(err)=>{
                reject(err);
            });
            
            archive.pipe(output);
            archive.directory(`./stacks/${this.stackName}`, false);
            archive.finalize();
        });
    }

    loadStackParameters(){
        const stackParameters = this.loadJsonFile(`./stacks/${this.stackName}/parameters.json`);
        const projectParameters = this.updateProjectStackParameters({parameters: stackParameters});

        this.parameters = {
            ...projectParameters,
            ...stackParameters,
            stackName: this.stackName,
            projectDeploymentBucketName: `${projectParameters.projectName.toLowerCase()}-deploymentbucket`
        }

        // Cognito Parameters
        Cognito.loadParameters(this.parameters);
        
        // Lambda Parameters
        Lambda.loadParameters(this.parameters);
    }

    async processStack(template="template.yml"){   
        console.log("Creating Stack Template file");
        const {stackType} = this.parameters;     
        const tplFilename = `./stacks/${this.stackName}/${template}`;
        let templateContent = fs.readFileSync(tplFilename, 'utf8');
        templateContent = this.replaceFiles(templateContent);
        templateContent = this.replaceParameters(templateContent);
        this.createOutput(templateContent, this.stackTemplateFilename);

        // If the Stack is an AWS_LAMBDA then zip the files and upload it to the Project Bucket
        if(stackType==="AWS_LAMBDA"){
            // Create Zip file with Lambda code
            await this.createLambdaZip();
        }
    }

    createOutput(template, output){
        fs.writeFile(output, template, err => {
            if(err) {
                return console.log(err);
            }
            console.log("The file was saved: " + output);
        }); 
    }

    replaceParameters(template){
        const variableSyntax = RegExp(/\${(.*?)}/g);
        const flattenParameters = flatten(this.parameters);
        const configVariables = Object.keys(flattenParameters);
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
                (accum, value) => Object.assign(accum, { [value]: flattenParameters[value] }),
                {},
            );

        let variables = Object.keys(substitutions).join('|');
        let regex = new RegExp("\\${(" + variables + ")}", "g");
        template = template.replace(regex, "|||$1|||");

        let templateJoin = template.split('|||');

        for (let i = 0; i < templateJoin.length; i++) {
            if (substitutions.hasOwnProperty(templateJoin[i])) {
                templateJoin[i] = substitutions[templateJoin[i]];
            }
        }
        return templateJoin.join('');
    }

    replaceFiles(template){
        const fileVariableSyntax = RegExp(/\${file\((.*?)\)/g);
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