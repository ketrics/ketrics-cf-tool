const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const archiver = require('archiver');
const AWS = require('aws-sdk');

const defaultTemplatePath = './node_modules/ketrics-cf/templates';

module.exports.CloudFormationGenerator = class {

    constructor(templatePath=defaultTemplatePath){
        this.templatePath = templatePath;
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

    async uploadToDeploymentBucket(){
        const {projectDeploymentBucketName, deploymentBucketKey} = this.parameters;
        try{
            const fileContent = fs.readFileSync(this.zipFilename);
            
            // call S3 to retrieve upload file to specified bucket
            const s3 = new AWS.S3({apiVersion: '2006-03-01'});
            const params = {
                Bucket: projectDeploymentBucketName,
                Body: fileContent,
                Key: deploymentBucketKey
            };
            const data = await s3.upload(params).promise();
            console.log("File uploaded:");
            console.log(data);
        }catch(err){
            console.log(err);
            throw err;
        }
    }

    async getStack(){
        try{
            const {stackName} = this.parameters;
            const cloudformation = new AWS.CloudFormation();
            const params = {
                StackStatusFilter: [
                    'CREATE_COMPLETE', 
                    'UPDATE_COMPLETE'
                  ]
            }
            const {StackSummaries} = await cloudformation.listStacks(params).promise();
            const stack = StackSummaries.find(stack=>stack.StackName===stackName);
            return stack;
        }catch(err){
            console.log(err);
            throw err;
        }
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
        
        console.log(parameters);

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
            let awsCmd;
            const {stackName} = args;
            this.loadStackParameters(stackName);
            
            if(script==="build"){
                await this.processStack();
            }if(script==="test"){
                console.log({cmd, script, args, argvs});
            }else {
                const {AwsRegion, stackType} = this.parameters;
                // Set the region
                AWS.config.update({region: AwsRegion});
                // Gets the Stack if it is already deployed
                const stack = await this.getStack();
                if(script==="deploy"){
                    // Creates Project Bucket to upload Stacks files
                    await this.createProjectDeploymentBucket();
                    // Create the Stack template replacing the parameters and files
                    await this.processStack();

                    if(stackType==="AWS_LAMBDA"){
                        // Upload Lambda code to Project Bucket
                        await this.uploadToDeploymentBucket();
                    }
                    
                    if(stack){
                        console.log(`Updating stack ${stackName}`);
                        awsCmd = `aws cloudformation update-stack --stack-name ${stackName} --template-body file://$PWD/build/${stackName}.yml  --capabilities CAPABILITY_IAM --capabilities CAPABILITY_NAMED_IAM`;
                        this.runCmd(awsCmd);
                    }else{
                        console.log(`Creating stack ${stackName}`);
                        awsCmd = `aws cloudformation create-stack --stack-name ${stackName} --template-body file://$PWD/build/${stackName}.yml  --capabilities CAPABILITY_IAM --capabilities CAPABILITY_NAMED_IAM`;
                        this.runCmd(awsCmd);
                    }
                }else if(script==="remove"){
                    if(stack){
                        awsCmd = `aws cloudformation delete-stack --stack-name ${stackName} `;
                        this.runCmd(awsCmd);
                    }else{
                        console.log(`The stack ${stackName} doens't exist`);
                    }
                }else if(script==="create"){
                    const {template} = args;
                    if(stack){
                        console.log(`Stack ${stackName} already exist`);
                    }else{
                        this.createStackFromTemplate(template);
                    }
                }
            }
        }
    }

    createStackFromTemplate(template){
        const {stackName} = this.parameters;
        if(stackName && template){
            const source = `${this.templatePath}/${template}`;
            const target = `./stacks/${stackName}`;
    
            if ( fs.existsSync( target ) ) {
                console.log(`There is already a Stack named: ${stackName}`);
            }else{
                console.log(`Creating Stack: ${stackName} from template ${template}`);
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
            const {stackName} = this.parameters;
            const zipFilename = path.join(process.cwd(), `./build/${stackName}.zip`);
            const output = fs.createWriteStream(zipFilename);
            const archive = archiver('zip');

            output.on('close', function () {
                console.log(archive.pointer() + ' total bytes');
                console.log(`Zip file created: ${zipFilename}`);
                resolve(zipFilename);
            });
            
            archive.on('error', function(err){
                reject(err);
            });
            
            archive.pipe(output);
            archive.directory(`./stacks/${stackName}`, false);
            archive.finalize();
        });
    }

    loadStackParameters(stackName){
        const globalParameters = this.loadJsonFile('./parameters.json');
        const stackParametersFilename = `./stacks/${stackName}/parameters.json`;
        const stackParameters = this.loadJsonFile(stackParametersFilename);
        const projectDeploymentBucketName = `${globalParameters.projectName.toLowerCase()}-deploymentbucket`;

        this.parameters = {
            ...globalParameters,
            ...stackParameters,
            stackName,
            projectDeploymentBucketName
        }
    }

    async processStack(template="template.yml"){   
        const {stackName, stackType} = this.parameters;     
        const tplFilename = `./stacks/${stackName}/${template}`;
        let templateContent = fs.readFileSync(tplFilename, 'utf8');
        templateContent = this.replaceFiles(templateContent);
        templateContent = this.replaceParameters(templateContent);
        this.createOutput(templateContent, path.join('./build', `${stackName}.yml`));

        // If the Stack is an AWS_LAMBDA then zip the files and upload it to the Project Bucket
        if(stackType==="AWS_LAMBDA"){
            // Create Zip file with Lambda code
            this.zipFilename = await this.createLambdaZip(stackName);
        }

        return tplFilename;
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
        const variableSyntax = RegExp(/\${([\w\d-_]+)}/g);
        const configVariables = Object.keys(this.parameters);
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
                (accum, value) => Object.assign(accum, { [value]: this.parameters[value] }),
                {},
            );
        
        let variables = Object.keys(substitutions).join('|');
        let regex = new RegExp("\\${(" + variables + ")}", "g");
        template = template.replace(regex, "|||$1|||");

        let templateJoin = template.split('|||');
        for (let i = 0; i < templateJoin.length; i++) {
            if (substitutions[templateJoin[i]]) {
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