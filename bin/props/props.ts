const baseProps = {
  env: { account: 'NUMBERACCOUNT', region: 'us-east-1' },
  pipelineName: 'pipelineName',
  codeBuildName: 'CodeBuild-Deploy',
  codeBuildNameGitPull: 'CodeBuildGitLab',
  bucketRepo: "artifact-pipeline",
  bucketArtifact: 'artifact-codebuild',
  secret: 'Secret',
  gitUrl: 'SSH LINK TO CLONE'
}

const dev = {
  ...baseProps,
  branchName: 'develop',
  environment: 'dev',
  microserviceName: "pipeline",
  
}

const qa = {
  ...baseProps,
  branchName: 'testing',
  environment: 'qa'
}

const prd = {
  ...baseProps,
  branchName: 'master',
  environment: 'prd'
}


export const PROPS = {
  dev,
  qa,
  prd
}