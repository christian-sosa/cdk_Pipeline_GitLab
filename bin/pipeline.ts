#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CdkPipelineStack } from '../lib/pipeline-stack';
import { PROPS } from './props/props'


const app = new cdk.App();
new CdkPipelineStack(app, 'PipelineStack', PROPS.dev);
