import { describe, it, expect, vi } from 'vitest';

const findTokenAddressByShortKey = vi.fn();
vi.mock('@racerbot/db', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/db')>()),
  findTokenAddressByShortKey: (...args: any[]) => findTokenAddressByShortKey(...args),
}));

const { resolveTokenKey, ExpiredTokenKeyError } = await import('./wallet.js');
const AGENT_ELY = '0x236F08aeC319E8eEE7FFcbA687f331E6d5180E4C';

describe('Buy buttons after a restart', () => {
  it('passes a real address straight through', async () => {
    expect(await resolveTokenKey(AGENT_ELY)).toBe(AGENT_ELY);
    expect(findTokenAddressByShortKey).not.toHaveBeenCalled();
  });

  it('finds a short key the bot forgot in the database', async () => {
    findTokenAddressByShortKey.mockResolvedValueOnce(AGENT_ELY);
    expect(await resolveTokenKey('t_3005b3130E4C')).toBe(AGENT_ELY);
    // Remembered for next time without another database read
    expect(await resolveTokenKey('t_3005b3130E4C')).toBe(AGENT_ELY);
    expect(findTokenAddressByShortKey).toHaveBeenCalledTimes(1);
  });

  it('asks for the address again instead of treating an unknown key as a NEAR token', async () => {
    findTokenAddressByShortKey.mockResolvedValueOnce(null);
    const err = await resolveTokenKey('t_deadbeef1234').catch(e => e);
    expect(err).toBeInstanceOf(ExpiredTokenKeyError);
    expect(err.message).toMatch(/button has expired.*Paste the token address again.*Nothing was spent/);
  });
});
