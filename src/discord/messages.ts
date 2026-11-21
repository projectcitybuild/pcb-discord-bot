export type AccountEvent = 'linked' | 'disconnected';

export function formatRoleChangeMessage(
  added: readonly string[],
  removed: readonly string[],
): string {
  const changes = [
    ...added.map((name) => `- **${name}** has been added.`),
    ...removed.map((name) => `- **${name}** has been removed.`),
  ];

  return `**Role Update**\n\nThe following changes have been made to your Discord roles:\n\n${changes.join('\n')}`;
}

export function formatAccountEventMessage(event: AccountEvent): string {
  return event === 'linked'
    ? '**Discord Account Linked**\n\nYour Discord account is now linked to your Project City account. Your server roles will be synchronized shortly.'
    : '**Discord Account Disconnected**\n\nYour Discord account has been disconnected from your Project City account. Your current server roles will remain unchanged.';
}