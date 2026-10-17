import { createShareLink, revokeShareLink, rotateShareLink } from '../src/lib/server/auth';
import { config } from '../src/lib/server/config';

const [command = 'create', ...extra] = process.argv.slice(2);
try {
  if (extra.length || !['create', 'rotate', 'revoke'].includes(command)) throw new Error('Usage: npm run share -- [create | rotate | revoke]');
  if (command === 'revoke') {
    revokeShareLink();
    console.log('Shared link revoked. Shared-link visitors have been signed out. Their photos remain in the collection.');
  } else {
    const token = command === 'rotate' ? rotateShareLink() : createShareLink();
    const link = new URL('/', config.origin);
    link.hash = `share=${token}`;
    console.log(link.toString());
    console.log('Share this one link with your friends. Each visitor enters their name and receives a personal upload folder.');
    console.log('Save the link now: only its hash is stored, so it cannot be shown again.');
    if (command === 'rotate') console.log('Previous shared links no longer work and shared-link visitors have been signed out. Personal invitations are unchanged.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The shared-link command failed.');
  process.exitCode = 1;
}
