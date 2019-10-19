module.exports.Lambda = class {
    static loadParameters(parameters){
        const {stackFolder, stackName} = parameters;
        const functionName = stackName;

        parameters.functionName = functionName;
        parameters.lambdaCodeBucketKey = `${stackFolder}/${stackName}.zip`;
        parameters.lambdaCodeFilename = `./build/${stackName}.zip`;
        
    }
}