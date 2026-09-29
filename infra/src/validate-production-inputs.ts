import { parseProductionDeploymentEnvironment } from "./deployment-inputs.js";

try {
  parseProductionDeploymentEnvironment(process.env);
  process.stdout.write("Production deployment inputs are valid.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid production deployment inputs."}\n`);
  process.exitCode = 1;
}
