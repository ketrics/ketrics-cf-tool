module.exports.Cognito = class {
    static loadParameters(parameters){
        const {stackName, lambdaConfig} = parameters;
        parameters.cognitoUsersBucketName = `${stackName.toLowerCase()}-usersbucket`;

        if(lambdaConfig){
            parameters.lambdaConfigPostConfirmation = lambdaConfig.postConfirmationLambdaArn ? 
            `PostConfirmation: "${lambdaConfig.postConfirmationLambdaArn}"`: "";

            parameters.lambdaConfigPreTokenGeneration = lambdaConfig.preTokenGenerationLambdaArn ? 
            `PreTokenGeneration: "${lambdaConfig.preTokenGenerationLambdaArn}"`: "";
        }
    }
}