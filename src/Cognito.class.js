module.exports.Cognito = class {
    static loadParameters(parameters){
        const {lambdaConfig} = parameters;

        if(lambdaConfig){
            parameters.lambdaConfigPostConfirmation = lambdaConfig.postConfirmationLambdaArn ? 
            `PostConfirmation: "${lambdaConfig.postConfirmationLambdaArn}"`: "";

            parameters.lambdaConfigPreTokenGeneration = lambdaConfig.preTokenGenerationLambdaArn ? 
            `PreTokenGeneration: "${lambdaConfig.preTokenGenerationLambdaArn}"`: "";
        }
    }
}