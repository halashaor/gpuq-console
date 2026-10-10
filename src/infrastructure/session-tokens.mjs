import {createHash, randomBytes, randomUUID} from 'node:crypto';

export class SessionTokens {
  create() {
    const credential = randomBytes(32).toString('hex');
    return {id: randomUUID(), credential, hash: createHash('sha256').update(credential).digest('hex')};
  }
}
