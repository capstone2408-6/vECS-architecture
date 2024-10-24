import json
import os
import boto3

# Initialize the ECS client
ecs_client = boto3.client('ecs')

def lambda_handler(event, context):
    # Check if this is a delete event
    if event.get('RequestType') == 'Delete':
        print("Stack is being deleted, no ECS task will be started.")
        return {
            'statusCode': 200,
            'body': json.dumps("Delete event - no action taken.")
        }
    
    # Check if triggered by S3 event (with 'Records' key)
    if 'Records' in event:
        # Extract information from the S3 event
        bucket_name = event['Records'][0]['s3']['bucket']['name']
        document_key = event['Records'][0]['s3']['object']['key']
        s3_url = f"s3://{bucket_name}/{document_key}"  # Single document
    else:
        # When triggered for all documents (e.g., on deployment)
        bucket_name = os.getenv('S3_BUCKET_NAME')  # Ensure you have this environment variable set
        s3_url = f"s3://{bucket_name}/"  # Entire bucket
    
    # Environment variables 
    aws_access_key = os.getenv('MY_AWS_ACCESS_KEY_ID')
    aws_secret_key = os.getenv('MY_AWS_SECRET_ACCESS_KEY')
    pinecone_api_key = os.getenv('PINECONE_API_KEY')
    embedding_model_name = os.getenv('EMBEDDING_MODEL_NAME')
    pinecone_index_name = os.getenv('PINECONE_INDEX_NAME')
    local_file_download_dir = '/tmp/'  # Temporary directory for Lambda file storage

    # Get the security group ID from environment variables
    security_group_id = os.getenv('SECURITY_GROUP_ID')
    
    # Start ECS Fargate Task
    response = ecs_client.run_task(
        cluster=os.getenv('ECS_CLUSTER_NAME'),  # ECS cluster name where the task will run
        launchType='FARGATE',
        taskDefinition=os.getenv('ECS_TASK_DEFINITION'),  # ECS task definition name
        overrides={
            'containerOverrides': [
                {
                    'name': 'unstructured-demo',  # Name of the container in ECS Task
                    'environment': [
                        {'name': 'AWS_S3_URL', 'value': s3_url},
                        {'name': 'AWS_ACCESS_KEY_ID', 'value': aws_access_key},
                        {'name': 'AWS_SECRET_ACCESS_KEY', 'value': aws_secret_key},
                        {'name': 'PINECONE_API_KEY', 'value': pinecone_api_key},
                        {'name': 'EMBEDDING_MODEL_NAME', 'value': embedding_model_name},
                        {'name': 'PINECONE_INDEX_NAME', 'value': pinecone_index_name},
                        {'name': 'LOCAL_FILE_DOWNLOAD_DIR', 'value': local_file_download_dir}
                    ],
                },
            ],
        },
        networkConfiguration={
            'awsvpcConfiguration': {
                'subnets': [os.getenv('SUBNET_ID')],  # Subnet for the ECS task
                'securityGroups': [security_group_id],  # Add security group here
                'assignPublicIp': 'ENABLED'
            }
        }
    )

    # Response with task information
    return {
        'statusCode': 200,
        'body': json.dumps(f"Started ECS Fargate Task: {response['tasks'][0]['taskArn']}")
    }