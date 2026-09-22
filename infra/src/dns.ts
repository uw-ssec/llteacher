import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { InfraConfig } from "./config.js";

export interface DnsResources {
  hostedZone: aws.route53.Zone;
  certificateArn: pulumi.Output<string>;
  appRecord: aws.route53.Record;
}

/** The first apply creates delegation records without waiting for the registrar.
 * Set domainReady after delegation to validate the certificate and activate TLS. */
export function createDnsResources(name: string, config: InfraConfig, alb: aws.lb.LoadBalancer, provider: aws.Provider): DnsResources | undefined {
  if (!config.domainName) return undefined;
  const options = { provider };
  const hostedZone = new aws.route53.Zone(`${name}-zone`, { name: config.domainName }, options);
  const certificate = new aws.acm.Certificate(`${name}-certificate`, {
    domainName: config.domainName,
    validationMethod: "DNS",
    tags: config.environment === "production" && !config.isLocal ? { LLTeacherStack: "production" } : undefined,
  }, options);
  const validationRecord = new aws.route53.Record(`${name}-certificate-validation-record`, {
    name: certificate.domainValidationOptions.apply((values) => values[0].resourceRecordName),
    type: certificate.domainValidationOptions.apply((values) => values[0].resourceRecordType),
    records: [certificate.domainValidationOptions.apply((values) => values[0].resourceRecordValue)],
    ttl: 60,
    zoneId: hostedZone.zoneId,
  }, options);
  const certificateArn = config.domainReady ? new aws.acm.CertificateValidation(`${name}-certificate-validation`, {
    certificateArn: certificate.arn,
    validationRecordFqdns: [validationRecord.fqdn],
  }, options).certificateArn : certificate.arn;
  const appRecord = new aws.route53.Record(`${name}-app-alias`, {
    name: config.domainName,
    zoneId: hostedZone.zoneId,
    type: "A",
    aliases: [{ name: alb.dnsName, zoneId: alb.zoneId, evaluateTargetHealth: true }],
  }, options);
  return { hostedZone, certificateArn, appRecord };
}
