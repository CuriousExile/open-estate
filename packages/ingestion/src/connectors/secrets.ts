import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Resolves a `secretRef` (Secrets Manager name or ARN) to its secret string.
 * Implementations and callers must never log or embed the returned value in errors.
 */
export interface SecretResolver {
  get(secretRef: string): Promise<string>;
}

/** Production resolver backed by AWS Secrets Manager. */
export class SecretsManagerSecretResolver implements SecretResolver {
  constructor(private readonly client: SecretsManagerClient = new SecretsManagerClient({})) {}

  async get(secretRef: string): Promise<string> {
    const out = await this.client.send(new GetSecretValueCommand({ SecretId: secretRef }));
    if (typeof out.SecretString !== 'string' || out.SecretString.length === 0) {
      throw new Error(`secret "${secretRef}" has no SecretString`);
    }
    return out.SecretString;
  }
}

/** Fails fast when a module needs a secret but `connectors.json` has no `secretRef`. */
export function requireSecretRef(secretRef: string | undefined, module: string): string {
  if (secretRef === undefined) throw new Error(`connector module "${module}" requires secretRef`);
  return secretRef;
}
