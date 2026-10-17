import { createMember, listMembers, revokeMember, rotateMember } from '../src/lib/server/auth';
import { config } from '../src/lib/server/config';

const [command, folder, ...nameParts] = process.argv.slice(2);

function printInvitation(result: ReturnType<typeof createMember>) {
  const invitation = new URL('/', config.origin);
  invitation.hash = `invite=${result.token}`;
  console.log(`${result.member.name} → ${result.member.folder}/`);
  console.log(invitation.toString());
  console.log('Share this private invitation with this person. It grants upload access to their folder and download access to the collection.');
}

try {
  switch (command) {
    case 'add':
      if (!folder || !nameParts.length) throw new Error('Usage: npm run user -- add alice "Alice"');
      printInvitation(createMember(nameParts.join(' '), folder));
      break;
    case 'rotate':
      if (!folder || nameParts.length) throw new Error('Usage: npm run user -- rotate alice');
      printInvitation(rotateMember(folder));
      console.log('Previous invitations and sessions have been invalidated.');
      break;
    case 'revoke':
      if (!folder || nameParts.length) throw new Error('Usage: npm run user -- revoke alice');
      revokeMember(folder);
      console.log(`Access revoked for ${folder}. Their photos remain in the collection.`);
      break;
    case 'list': {
      if (folder) throw new Error('Usage: npm run user -- list');
      const members = listMembers();
      if (!members.length) console.log('No members yet. Add one with: npm run user -- add alice "Alice"');
      else console.table(members.map(({ folder, name }) => ({ folder, name })));
      break;
    }
    default:
      throw new Error('Usage: npm run user -- add <folder> <name> | rotate <folder> | revoke <folder> | list');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The member command failed.');
  process.exitCode = 1;
}
