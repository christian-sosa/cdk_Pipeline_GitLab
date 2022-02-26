import { StackProps } from 'aws-cdk-lib';

export interface PipelineProps extends StackProps {
    bucketRepo:string;
    bucketArtifact:string;
    pipelineName:string;
    codeBuildName: string;
    codeBuildNameGitPull:string;
    secret: string;
    gitUrl:string;
    branchName: string;
    environment:string;
    microserviceName:string;
}
