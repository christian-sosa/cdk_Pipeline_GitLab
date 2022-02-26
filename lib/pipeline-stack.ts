import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';


import { ActionCategory, CfnCustomActionType, CfnPipeline} from 'aws-cdk-lib/aws-codepipeline';
import { Cache, ComputeType, LinuxBuildImage, LocalCacheMode } from 'aws-cdk-lib/aws-codebuild';
import { PipelineProps } from '../interfaces/pipeline-props';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import * as fs from 'fs';
import * as jsyaml from 'js-yaml';
import * as yaml from 'yaml';
import { Stack } from "aws-cdk-lib";


export class CdkPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineProps) {
    super(scope, id, props);

    const lambdaPipelineName = `start-pipeline`;
    const apiGatewayName = `apigateway-lambda-pipeline`;    
 
    const lambdaRole = new iam.Role(this, `${lambdaPipelineName}-role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: `${lambdaPipelineName}-role`,
      managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodePipelineFullAccess')
      ]
    });

    const lambdaCodePipeline = new lambda.Function(this, `${lambdaPipelineName}-Handler`, {
      functionName: lambdaPipelineName,
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.fromAsset('microservices/codepipeline'),
      handler: 'lambda_function.lambda_handler',
      role: lambdaRole,
      memorySize: 128,
      timeout: cdk.Duration.seconds(10)
    });

    const api = new apigateway.LambdaRestApi(this, `${apiGatewayName}-api`, {
      handler: lambdaCodePipeline,
      proxy: false,
      restApiName: apiGatewayName,
      deploy: true,
      deployOptions:{
        stageName: "prod"
      }
    });

    const itemsAccionar = api.root.addResource('accionar');
    const methodAnyAccionar = itemsAccionar.addMethod('ANY', new apigateway.LambdaIntegration(lambdaCodePipeline), { apiKeyRequired: false });

    

    const kmskey = this.createKmsKey();

    const configurationProperties = require("./configurationProperties");
    const settingsCustomActiontype = require("./settingsCustomActionType");
    const customActiontype = this.createCustomActionTypeForCustomGitSource(configurationProperties, settingsCustomActiontype);

    const codebuildGitLab = this.createCodeBuildStagePull(props);
    const codebuild = this.createCodeBuildStage(props);
    const lambdaFunction = this.lambdaFunction(props);

    const pipeline = this.createPipelineCfn(props,kmskey)
    const webhook = this.createWebhook(props);
    
    const eventRule = new Rule(this, 'EventPipeline');
    eventRule.addEventPattern({
      source: ['aws.codepipeline'],
      detailType: ["CodePipeline Action Execution State Change"],
      detail: {
        type: {
          provider: ["CustomSourceForGit"],
          category: ["Source"],
          owner: ["Custom"]
        },
        state: ["STARTED"]
      }
    });
    eventRule.addTarget(new LambdaFunction(lambdaFunction));

    new cdk.CfnOutput(this, `Webhook url`, { value: webhook.attrUrl });
  };

  private createPipelineCfn(props: PipelineProps,kmskey:cdk.aws_kms.Key){
    const role = this.createPipelineRole(props)
    const pipeline = new CfnPipeline(this, "PipelineDEV", {
      name: props.pipelineName,
      roleArn: role.roleArn,
      artifactStore: {
        location: props.bucketRepo,
        type: "S3",
        encryptionKey: {
          id: kmskey.keyId,
          type: 'KMS',
        },
      },
      stages: [{
        name: "Source",
        actions: [{
          actionTypeId: {
            category: ActionCategory.SOURCE,
            owner: "Custom",
            provider: "CustomSourceForGit",
            version: '1',
          },
          outputArtifacts:[{name: 'MyApp'}],
          name: "Source",
          runOrder: 1,
          configuration: {
            Branch: props.branchName,
            GitUrl: props.gitUrl,
            PipelineName: props.pipelineName,
            SSHSecretKeyName: props.secret
          }
        }]
      },
      {
        name: "Build",
        actions: [{
          name: "Build",
          actionTypeId: {
            category: ActionCategory.BUILD,
            owner: "AWS",
            provider: "CodeBuild",
            version: '1',
          },
          configuration: {
            ProjectName: `${props.codeBuildName}-${props.environment.toUpperCase()}`
          },
          runOrder: 1,
          outputArtifacts:[{name:"MyAPPBUILT"}],
          inputArtifacts: [{name: 'MyApp'}]
        }]
      }]
    });  
    return pipeline;  
  };

  private createWebhook(props:PipelineProps){
    return  new codepipeline.CfnWebhook(this,'WebhookPipeline',{
      authentication: 'UNAUTHENTICATED',
      authenticationConfiguration: {},
      filters: [{
        jsonPath: '$.ref',
        matchEquals: 'refs/heads/{Branch}',
      }],
      targetAction: 'Source',
      targetPipeline: props.pipelineName,
      targetPipelineVersion: 1,
      name: 'Webhookpipeline',
      registerWithThirdParty: false,
    })
  };
  
  private createPipelineRole(props: PipelineProps) {
    const role = new iam.Role(this, 'pipelineRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
      roleName: `PipelineRole-${props.environment}`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
      ]
    });
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["iam:PassRole"],
      resources: ['*']
    }));
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["codebuild:BatchGetBuilds","codebuild:StartBuild"],
      resources: ['*']
    }));
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey"],
      resources: ["*"]
      //KMS KEY
    }));
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue"],
      resources: ['*']
    }));
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["kms:GenerateDataKey"],
      resources: ["*"]
    }));
  
    return role;
  }

  private createCodeBuildStage(props: PipelineProps) {
    const codeBuildRole = this.createCodeBuildRoleDespliegue(props);
    return new codebuild.PipelineProject(this, 'CodeBuildDeploy', {
      projectName:`${props.codeBuildName}-${props.environment.toUpperCase()}`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      environmentVariables: {
        "branch": { value: props.branchName }
      },
      role: codeBuildRole,
      environment: {
        buildImage: LinuxBuildImage.STANDARD_5_0,
        computeType: ComputeType.SMALL
      },
      cache: Cache.local(LocalCacheMode.SOURCE),
    });
  };



  private createCodeBuildRoleDespliegue(props: PipelineProps) {
    const codeBuildRole = new iam.Role(this, 'codeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      roleName: `CodeBuildRole-Despliegue-${props.environment}`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeBuildAdminAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess')
      ]
    });

    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey"],
      resources: ["*"]
      //KMS KEY
    }));

    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter"],
      resources: ["*"]
    }));

    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["iam:PassRole"],
      resources: ['*']
    }));

    
    return codeBuildRole;
  };

  private createCodeBuildRolePull(props: PipelineProps) {
    const codeBuildRole = new iam.Role(this, 'codeBuildRolePull', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      roleName: `CodeBuildRole-GitPull-${props.environment}`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeBuildAdminAccess'),
      ]
    });

    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ec2:CreateNetworkInterface","ec2:DescribeDhcpOptions","ec2:DescribeNetworkInterfaces","ec2:DeleteNetworkInterface","ec2:DescribeSubnets","ec2:DescribeSecurityGroups","ec2:DescribeVpcs"],
      resources: ["*"]
    }));

    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["c2:CreateNetworkInterfacePermission"],
      resources: ["*"]
    }));

    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue","secretsmanager:DescribeSecret"],
      resources: ["*"]
    }));
    
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey",
      "kms:DescribeKey"],
      resources: ["*"]
    }));
    
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey"],
      resources: ["*"]
    }));
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ec2:CreateNetworkInterfacePermission"],
      resources: ["arn:aws:ec2:us-east-1:233669286383:network-interface/*"],
    }));
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ec2:CreateNetworkInterface",
      "ec2:DescribeDhcpOptions",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeVpcs"],
      resources: ["*"],
    }));
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "s3:PutObject",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetBucketAcl",
        "s3:GetBucketLocation"
      ],
      resources: ["*"],
    }));

    return codeBuildRole;
  };

  private createCodeBuildStagePull(props: PipelineProps) {
    const codeBuildRole = this.createCodeBuildRolePull(props);
    const buildspecNoParse = jsyaml.load(fs.readFileSync('yaml.yml', 'utf8'));
    const buildspecString = yaml.stringify(buildspecNoParse);
    
    return new codebuild.CfnProject  (this, 'CodeBuildGitPull', {
      vpcConfig: {vpcId:'vpc-xxx', subnets:['subnet-xxx'],securityGroupIds:['sg-xxx']},
      artifacts: {type:'S3',name: props.bucketArtifact, location: props.bucketArtifact},
      serviceRole: codeBuildRole.roleArn,
      environment: {
        image: 'aws/codebuild/standard:5.0',
        computeType: 'BUILD_GENERAL1_SMALL',
        type: 'LINUX_CONTAINER'
      },
      source: {type: 'NO_SOURCE',buildSpec:buildspecString},
      queuedTimeoutInMinutes: 60,
      timeoutInMinutes: 14,
      name: props.codeBuildNameGitPull,
      logsConfig: { cloudWatchLogs: {status: 'ENABLED', groupName: 'gitlabpullproject'}}
    });
  };

  private createCustomActionTypeForCustomGitSource(configurationProperties:any, settings:CfnCustomActionType.SettingsProperty){
    return new CfnCustomActionType(this, "CustomSourceForGit", {
      category: ActionCategory.SOURCE,
      inputArtifactDetails: {
        maximumCount: 0,
        minimumCount: 0
      },
      outputArtifactDetails: {
        maximumCount: 1,
        minimumCount: 1
      },
      provider: "CustomSourceForGit",
      version: '1',
      configurationProperties,
      settings
    });
  };
  
  private lambdaExecutionRole(props:PipelineProps){
    const lambdaRole = new iam.Role(this, 'lambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: `lambdaRole-GitPull-${props.environment}`,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")]
    });

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["codepipeline:PollForJobs","codepipeline:AcknowledgeJob","codepipeline:GetJobDetails","codepipeline:PutJobSuccessResult","codepipeline:PutJobFailureResult","codepipeline:StopPipelineExecution"],
      resources: ["*"]
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["codebuild:StartBuild","codebuild:BatchGetBuilds"],
      resources: ["*"]
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ec2:CreateNetworkInterface","ec2:DescribeDhcpOptions","ec2:DescribeNetworkInterfaces","ec2:DeleteNetworkInterface","ec2:DescribeSubnets","ec2:DescribeSecurityGroups","ec2:DescribeVpcs"],
      resources: ["*"]
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["c2:CreateNetworkInterfacePermission"],
      resources: ["*"]
    }));
    
    return lambdaRole;
  };

  private lambdaFunction(props:PipelineProps){
    const role = this.lambdaExecutionRole(props)
    const lambdaFunc = new lambda.Function(this, 'Git-pull-lambda', {
      code: lambda.Code.fromAsset('microservices/build_function'),
      runtime: lambda.Runtime.PYTHON_3_8,
      handler: 'lambda_function.lambda_handler',
      role: role,
      timeout: cdk.Duration.seconds(900),
      environment: {
        GitPullCodeBuild: props.codeBuildNameGitPull
      }
    });
    return lambdaFunc   
  };

  private createKmsKey(){
    const kmskey = new kms.Key(this, 'cdkKey')
    kmskey.addAlias('alias/PipelineGitLab');
    return kmskey;
  };

}