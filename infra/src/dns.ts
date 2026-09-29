import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { InfraConfig } from "./config.js";

export interface DnsResources {
  hostedZone: aws.route53.Zone;
  certificateArn?: pulumi.Output<string>;
  appRecord: aws.route53.Record;
}

/** Production consumes an issued operator-owned certificate; it never owns its
 * lifecycle. Local/staging retain the managed certificate/validation flow. */
export function validateProductionCertificate(expectedArn: string, domainName: string, certificate: {
  arn: string; domainName: string; status: string; tags?: Record<string, string>;
}): string {
  if (certificate.arn !== expectedArn || certificate.domainName.toLowerCase() !== domainName.toLowerCase()
    || certificate.status !== "ISSUED" || certificate.tags?.LLTeacherStack !== "production") {
    throw new Error("Production certificate must match certificateArn/domainName, be ISSUED, and carry LLTeacherStack=production.");
  }
  return certificate.arn;
}

/** The first apply creates delegation records without waiting for the registrar.
 * Production enables TLS only after the operator issues and validates its cert. */
export function createDnsResources(name: string, config: InfraConfig, alb: aws.lb.LoadBalancer, provider: aws.Provider): DnsResources | undefined {
  if (!config.domainName) return undefined;
  const options = { provider };
  const hostedZone = new aws.route53.Zone(`${name}-zone`, { name: config.domainName }, options);
  let certificateArn: pulumi.Output<string> | undefined;
  if (config.environment === "production") {
    if (config.domainReady) {
      if (!config.certificateArn) throw new Error("Production domainReady=true requires an operator-provisioned certificateArn.");
      // get performs a read, not an import: Pulumi cannot update or delete this cert.
      const certificate = aws.acm.Certificate.get(`${name}-existing-certificate`, config.certificateArn, undefined, options);
      certificateArn = pulumi.output({ arn: certificate.arn, domainName: certificate.domainName, status: certificate.status, tags: certificate.tags })
        .apply(state => validateProductionCertificate(config.certificateArn!, config.domainName!, state));
    }
  } else {
    const certificate = new aws.acm.Certificate(`${name}-certificate`, {
      domainName: config.domainName,
      validationMethod: "DNS",
    }, options);
    const validationRecord = new aws.route53.Record(`${name}-certificate-validation-record`, {
      name: certificate.domainValidationOptions.apply((values) => values[0].resourceRecordName),
      type: certificate.domainValidationOptions.apply((values) => values[0].resourceRecordType),
      records: [certificate.domainValidationOptions.apply((values) => values[0].resourceRecordValue)],
      ttl: 60,
      zoneId: hostedZone.zoneId,
    }, options);
    certificateArn = config.domainReady ? new aws.acm.CertificateValidation(`${name}-certificate-validation`, {
      certificateArn: certificate.arn,
      validationRecordFqdns: [validationRecord.fqdn],
    }, options).certificateArn : certificate.arn;
  }
  const appRecord = new aws.route53.Record(`${name}-app-alias`, {
    name: config.domainName,
    zoneId: hostedZone.zoneId,
    type: "A",
    aliases: [{ name: alb.dnsName, zoneId: alb.zoneId, evaluateTargetHealth: true }],
  }, options);
  return { hostedZone, certificateArn, appRecord };
}
