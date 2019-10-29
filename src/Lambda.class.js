module.exports.Lambda = class {
    static loadParameters(parameters){
        const {stackFolder, stackName, functionName} = parameters;

        parameters.functionName = functionName || stackName;;
        parameters.lambdaCodeBucketKey = `${stackFolder}/${stackName}.zip`;
        parameters.lambdaCodeFilename = `./build/${stackName}.zip`;
        
    }
}