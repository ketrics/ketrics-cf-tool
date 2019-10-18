module.exports.Lambda = class {
    static loadParameters(parameters){
        const {stackName, functionName} = parameters;

        parameters.lambdaCodeBucketKey = `${stackName}/${functionName}.zip`;
        parameters.lambdaCodeFilename = `./build/${stackName}.zip`;
    }
}