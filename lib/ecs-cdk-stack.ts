import * as cdk from "aws-cdk-lib";
import { Stack, StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3_notifications from "aws-cdk-lib/aws-s3-notifications";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as dotenv from "dotenv";
import { Construct } from "constructs";

dotenv.config();

export class EcsCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 1. Define the S3 bucket (or reference an existing one)
    const bucket = s3.Bucket.fromBucketName(
      this,
      "MyExistingBucket",
      process.env.S3_BUCKET_NAME!
    );

    // 2. Create the ECS cluster
    const vpc = new ec2.Vpc(this, "MyVpc", {
      maxAzs: 3, // Number of Availability Zones
      natGateways: 1, // Use NAT for internet access if needed
    });

    const taskSecurityGroup = new ec2.SecurityGroup(this, "TaskSecurityGroup", {
      vpc,
      allowAllOutbound: true, // Allow outbound traffic
    });

    // Optional: Add specific inbound rules as needed
    taskSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP traffic"
    );
    taskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow outbound HTTPS traffic"
    );

    // Create an execution role for the Fargate task
    const executionRole = new iam.Role(this, "EcsTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Attach the necessary policy to the execution role
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSTaskExecutionRolePolicy"
      )
    );
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonEC2ContainerRegistryReadOnly"
      )
    );

    // Inline policy for ECR permissions
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:CreateLogGroup",
        ],
        resources: ["*"], // You might want to scope this down to specific log groups
      })
    );

    const cluster = new ecs.Cluster(this, "MyCluster", {
      vpc: vpc,
      containerInsights: true, // enabled for CloudWatch logs
    });

    // 3. Create the ECS task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, "MyTaskDef", {
      memoryLimitMiB: 3072, // 3 GB
      cpu: 1024, // 1 vCPU
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      executionRole,
    });

    const subnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PUBLIC, // or PRIVATE based on your need
    }).subnetIds;

    // 4. Add a container to the ECS task
    const container = taskDefinition.addContainer("unstructured-demo", {
      image: ecs.ContainerImage.fromRegistry(
        "public.ecr.aws/q1n8b2k4/hcamacho/unstructured-demo:latest"
      ),
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ecs",
        logGroup: new logs.LogGroup(this, "EcsLogGroup", {
          removalPolicy: cdk.RemovalPolicy.DESTROY, // Adjust as needed
        }),
      }),
      // memoryLimitMiB: 512,
    });

    container.addPortMappings({
      containerPort: 80,
    });

    // Create a role for the Lambda function
    const lambdaExecutionRole = new iam.Role(this, "LambdaExecutionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    // Attach the basic execution policy
    lambdaExecutionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AWSLambdaBasicExecutionRole"
      )
    );

    // Define the Lambda function
    const myLambda = new lambda.Function(this, "MyLambdaFunction", {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset("lambda"), // Path to Lambda code directory
      handler: "lambda_function.lambda_handler", // File name and handler function
      environment: {
        ECS_CLUSTER_NAME: cluster.clusterName,
        ECS_TASK_DEFINITION: taskDefinition.taskDefinitionArn,
        MY_AWS_ACCESS_KEY_ID: process.env.MY_AWS_ACCESS_KEY_ID!,
        MY_AWS_SECRET_ACCESS_KEY: process.env.MY_AWS_SECRET_ACCESS_KEY!,
        PINECONE_API_KEY: process.env.PINECONE_API_KEY!,
        EMBEDDING_MODEL_NAME: process.env.EMBEDDING_MODEL_NAME!,
        PINECONE_INDEX_NAME: process.env.PINECONE_INDEX_NAME!,
        SUBNET_ID: subnets[0],
        SECURITY_GROUP_ID: taskSecurityGroup.securityGroupId,
      },
      timeout: cdk.Duration.seconds(30), // Adjust timeout as needed
    });

    // Grant permissions for the Lambda to invoke ECS tasks
    myLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "ecs:RunTask",
          "ecs:DescribeTasks",
          "iam:PassRole",
        ],
        resources: ["*"],
      })
    );

    // Grant necessary permissions to access S3
    bucket.grantRead(myLambda);

    const notificationOptions: { prefix?: string; suffix?: string } = {};

    if (process.env.S3_NOTIFICATION_PREFIX) {
      notificationOptions.prefix = process.env.S3_NOTIFICATION_PREFIX;
    }

    if (process.env.S3_NOTIFICATION_SUFFIX) {
      notificationOptions.suffix = process.env.S3_NOTIFICATION_SUFFIX;
    }

    // Conditionally add the event notification with or without the filter
    if (notificationOptions.prefix || notificationOptions.suffix) {
      // Add the event notification with the filter (if either prefix or suffix exists)
      bucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3_notifications.LambdaDestination(myLambda),
        notificationOptions
      );
    } else {
      // Add the event notification without any filter
      bucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3_notifications.LambdaDestination(myLambda)
      );
    }
  }
}
