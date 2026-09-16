import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface Network {
  albSecurityGroup: aws.ec2.SecurityGroup;
  appSecurityGroup: aws.ec2.SecurityGroup;
  databaseSecurityGroup: aws.ec2.SecurityGroup;
  publicSubnetIds: pulumi.Output<string[]>;
  vpc: aws.ec2.Vpc;
}

export function createNetwork(name: string, provider: aws.Provider): Network {
  const options = { provider };
  const vpc = new aws.ec2.Vpc(`${name}-vpc`, {
    cidrBlock: "10.42.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: { Name: `${name}-vpc` },
  }, options);
  const internetGateway = new aws.ec2.InternetGateway(`${name}-igw`, {
    vpcId: vpc.id,
    tags: { Name: `${name}-igw` },
  }, options);
  const routeTable = new aws.ec2.RouteTable(`${name}-public-routes`, {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: internetGateway.id }],
  }, options);
  const subnets = ["10.42.1.0/24", "10.42.2.0/24"].map((cidrBlock, index) => {
    const subnet = new aws.ec2.Subnet(`${name}-public-${index + 1}`, {
      availabilityZone: `us-east-1${index === 0 ? "a" : "b"}`,
      cidrBlock,
      mapPublicIpOnLaunch: true,
      vpcId: vpc.id,
    }, options);
    new aws.ec2.RouteTableAssociation(`${name}-public-route-${index + 1}`, {
      routeTableId: routeTable.id,
      subnetId: subnet.id,
    }, options);
    return subnet;
  });

  const albSecurityGroup = new aws.ec2.SecurityGroup(`${name}-alb-sg`, {
    description: "Public HTTPS ingress to LLTeacher",
    egress: [{ cidrBlocks: ["0.0.0.0/0"], fromPort: 0, protocol: "-1", toPort: 0 }],
    ingress: [{ cidrBlocks: ["0.0.0.0/0"], fromPort: 443, protocol: "tcp", toPort: 443 }],
    vpcId: vpc.id,
  }, options);
  const appSecurityGroup = new aws.ec2.SecurityGroup(`${name}-app-sg`, {
    description: "Only the ALB can reach the ECS application",
    egress: [{ cidrBlocks: ["0.0.0.0/0"], fromPort: 0, protocol: "-1", toPort: 0 }],
    ingress: [{ fromPort: 8080, protocol: "tcp", securityGroups: [albSecurityGroup.id], toPort: 8080 }],
    vpcId: vpc.id,
  }, options);
  const databaseSecurityGroup = new aws.ec2.SecurityGroup(`${name}-database-sg`, {
    description: "Only the ECS application can reach Postgres",
    ingress: [{ fromPort: 5432, protocol: "tcp", securityGroups: [appSecurityGroup.id], toPort: 5432 }],
    vpcId: vpc.id,
  }, options);

  return { albSecurityGroup, appSecurityGroup, databaseSecurityGroup, publicSubnetIds: pulumi.all(subnets.map((subnet) => subnet.id)), vpc };
}
