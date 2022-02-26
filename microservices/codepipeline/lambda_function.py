import json
import boto3

client= boto3.client('codepipeline')

def lambda_handler(event, context):
    
    response = client.start_pipeline_execution(
        name='pipelineName'
    )
    # TODO implement
    print('funciono')
    return {
        'statusCode': 200,
        'body': json.dumps('Hello from Lambda!')
    }