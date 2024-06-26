import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

//const config = new pulumi.Config();
const cpu = 512;
const memory = 128;

const vpc = new awsx.ec2.Vpc(`vpc`, {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  numberOfAvailabilityZones: 2,
  natGateways: { strategy: "Single" },
  subnetStrategy: "Auto",
  subnetSpecs: [
    { type: awsx.ec2.SubnetType.Public },
    { type: awsx.ec2.SubnetType.Private },
    { type: awsx.ec2.SubnetType.Isolated },
  ],
});
const namespace = new aws.servicediscovery.PrivateDnsNamespace(
  `private-namespace`,
  {
    name: "novella.local",
    description: "Private DNS namespace for service discovery",
    vpc: vpc.vpcId,
  },
);

const internalSecurityGroup = new aws.ec2.SecurityGroup("securityGroup", {
  vpcId: vpc.vpcId,
});

//Allow all inbound traffic from within the same security group
new aws.vpc.SecurityGroupIngressRule("inner-traffic-in", {
  securityGroupId: internalSecurityGroup.id,
  ipProtocol: "-1",
  referencedSecurityGroupId: internalSecurityGroup.id,
});

//Allow all outbound traffic

new aws.vpc.SecurityGroupEgressRule("all-traffic-out", {
  securityGroupId: internalSecurityGroup.id,
  ipProtocol: "-1",
  cidrIpv4: "0.0.0.0/0",
});

const externalSecurityGroup = new aws.ec2.SecurityGroup(
  "external-security-group",
  {
    vpcId: vpc.vpcId,
  },
);
new aws.vpc.SecurityGroupIngressRule("all-traffic-in", {
  securityGroupId: internalSecurityGroup.id,
  ipProtocol: "-1",
  cidrIpv4: "0.0.0.0/0",
});

// An ECS cluster to deploy into
const cluster = new aws.ecs.Cluster("cluster", {});

// An ALB to serve the container endpoint to the internet
const loadbalancer = new awsx.lb.ApplicationLoadBalancer("alb", {
  subnetIds: vpc.publicSubnetIds,
  securityGroups: [internalSecurityGroup.id, externalSecurityGroup.id],
  defaultTargetGroup: {
    deregistrationDelay: 5,
    healthCheck: {
      path: "/",
      timeout: 5,
      healthyThreshold: 2,
      unhealthyThreshold: 2,
    },
  },
});

// An ECR repository to store our application's container image
const repo = new awsx.ecr.Repository("repo", {
  forceDelete: true,
  imageTagMutability: "IMMUTABLE",
});

// Build and publish our application's container image to the ECR repository
const image = new awsx.ecr.Image("image", {
  repositoryUrl: repo.url,
  context: "../",
  platform: "linux/amd64",
});

// Deploy an ECS Service on Fargate to host the application container
new awsx.ecs.FargateService("app-service", {
  cluster: cluster.arn,
  deploymentCircuitBreaker: {
    enable: true,
    rollback: false,
  },
  networkConfiguration: {
    subnets: vpc.privateSubnetIds,
    securityGroups: [internalSecurityGroup.id],
  },
  serviceConnectConfiguration: {
    enabled: true,
    namespace: namespace.arn,
    services: [
      {
        discoveryName: "frontend",
        portName: "front",
        clientAlias: [
          {
            dnsName: "frontend",
            port: 80,
          },
        ],
      },
    ],
  },
  taskDefinitionArgs: {
    container: {
      name: "app",
      image: image.imageUri,
      cpu: cpu,
      memory: memory,
      essential: true,
      portMappings: [
        {
          name: "front",
          containerPort: 80,
          hostPort: 80,
          targetGroup: loadbalancer.defaultTargetGroup,
        },
      ],
      environment: [
        { name: "PORT", value: "80" },
        {
          name: "DATABASE_URL",
          value: "postgresql://postgres:postgres@main-db:5432/postgres",
        },
        { name: "SESSION_SECRET", value: "super-duper-s3cret" },
      ],
    },
  },
});

const efsFileSystem = new aws.efs.FileSystem(`postgres-efs`);

const mountTargetSecurityGroup = new aws.ec2.SecurityGroup("mount-target-sg", {
  vpcId: vpc.vpcId,
});

new aws.vpc.SecurityGroupIngressRule("nfs-ingress", {
  securityGroupId: mountTargetSecurityGroup.id,
  ipProtocol: "tcp",
  fromPort: 2049,
  toPort: 2049,
  referencedSecurityGroupId: internalSecurityGroup.id,
});

new aws.vpc.SecurityGroupEgressRule("all-egress", {
  securityGroupId: mountTargetSecurityGroup.id,
  ipProtocol: "-1",
  referencedSecurityGroupId: internalSecurityGroup.id,
});

const accessPoint = new aws.efs.AccessPoint("efs-access-point", {
  fileSystemId: efsFileSystem.id,
});

new aws.efs.MountTarget(`efs-mount-target`, {
  fileSystemId: efsFileSystem.id,
  subnetId: vpc.privateSubnetIds[0],
  securityGroups: [mountTargetSecurityGroup.id],
});

new aws.efs.MountTarget(`efs-mount-target-2`, {
  fileSystemId: efsFileSystem.id,
  subnetId: vpc.privateSubnetIds[1],
  securityGroups: [mountTargetSecurityGroup.id],
});

new awsx.ecs.FargateService(`postgres-service`, {
  cluster: cluster.arn,
  deploymentCircuitBreaker: {
    enable: true,
    rollback: true,
  },
  networkConfiguration: {
    subnets: vpc.privateSubnetIds,
    securityGroups: [internalSecurityGroup.id],
  },
  serviceConnectConfiguration: {
    enabled: true,
    namespace: namespace.arn,
    services: [
      {
        discoveryName: "main-db",
        portName: "pg",
        clientAlias: [
          {
            dnsName: "main-db",
            port: 5432,
          },
        ],
      },
    ],
  },

  taskDefinitionArgs: {
    //taskRole:
    container: {
      name: "postgres",
      image: "postgres:latest",
      portMappings: [
        {
          name: "pg",
          containerPort: 5432,
          hostPort: 5432,
        },
      ],
      environment: [
        { name: "POSTGRES_USER", value: "postgres" },
        { name: "POSTGRES_PASSWORD", value: "postgres" },
        { name: "POSTGRES_DB", value: "postgres" },
      ],
      healthCheck: {
        command: ["CMD-SHELL", "pg_isready -U postgres"],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 60,
      },
      mountPoints: [
        {
          sourceVolume: "postgres-data",
          containerPath: "/var/lib/postgresql/data",
          readOnly: false,
        },
      ],
    },
    volumes: [
      {
        name: "postgres-data",
        efsVolumeConfiguration: {
          fileSystemId: efsFileSystem.id,
          transitEncryption: "ENABLED",
          authorizationConfig: {
            accessPointId: accessPoint.id,
            // iam: "ENABLED",
          },
        },
      },
    ],
  },
});

// The URL at which the container's HTTP endpoint will be available
export const url = pulumi.interpolate`http://${loadbalancer.loadBalancer.dnsName}`;
