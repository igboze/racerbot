import { describe, it, expect } from 'vitest';
import {
  generateRandomFleetTag,
  buildFleetPromoCard,
  RACEFLEET_MONTHLY_FEE_NEAR,
  MIN_FLEET_WALLETS,
  MAX_FLEET_WALLETS,
} from './raceFleet.js';
import { KeyPair } from 'near-api-js';
import { encrypt, decrypt, generateRandomAccountPrefix } from '@racerbot/shared';

describe('RaceFleet Suite', () => {
  it('generates compliant, privacy-preserving randomized fleet tags', () => {
    const tag1 = generateRandomFleetTag();
    const tag2 = generateRandomFleetTag();

    expect(tag1).toMatch(/^f-[a-z]+-[a-z]+-\d{3}$/);
    expect(tag2).toMatch(/^f-[a-z]+-[a-z]+-\d{3}$/);
    expect(tag1).not.toBe(tag2);
  });

  it('validates subscription constants and wallet limits', () => {
    expect(RACEFLEET_MONTHLY_FEE_NEAR).toBe(2);
    expect(MIN_FLEET_WALLETS).toBe(1);
    expect(MAX_FLEET_WALLETS).toBe(25);
  });

  it('builds attractive promo card with correct pricing and deployment buttons', () => {
    const promo = buildFleetPromoCard();
    expect(promo.text).toContain('🏎 <b>Unlock RacerBot RaceFleet [BETA]</b>');
    expect(promo.text).toContain('2 NEAR / month');
    expect(promo.text).toContain('20 named RacerBot wallets');
    expect(promo.text).toContain('1-Block Bundle Sniping');

    // Verify inline keyboard buttons exist
    const buttons = promo.keyboard.reply_markup.inline_keyboard.flat();
    const callbacks = buttons.map((b: any) => b.callback_data);
    expect(callbacks).toContain('fleet_deploy:5');
    expect(callbacks).toContain('fleet_deploy:10');
    expect(callbacks).toContain('fleet_deploy:15');
    expect(callbacks).toContain('fleet_deploy:20');
  });

  it('encrypts and decrypts fleet wallet keypairs reliably', () => {
    const testMasterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const keyPair = KeyPair.fromRandom('ed25519');
    const privateKeyStr = keyPair.toString();

    const encrypted = encrypt(privateKeyStr, testMasterKey);
    expect(encrypted).not.toBe(privateKeyStr);

    const decrypted = decrypt(encrypted, testMasterKey);
    expect(decrypted).toBe(privateKeyStr);

    const restoredKeyPair = KeyPair.fromString(decrypted as any);
    expect(restoredKeyPair.getPublicKey().toString()).toBe(keyPair.getPublicKey().toString());
  });

  it('produces diverse, organic account names without coordinated index sequences', () => {
    const parent = 'racerbot.near';
    const names = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const accountId = `${generateRandomAccountPrefix()}.${parent}`;
      expect(accountId).toMatch(/^[a-z]+-[a-z]+-\d{4}\.racerbot\.near$/);
      // Ensure no coordinated sequence patterns like "-01", "-02"
      expect(accountId).not.toMatch(/-0[1-5]\.racerbot\.near$/);
      names.add(accountId);
    }
    // High entropy: generated names must be distinct
    expect(names.size).toBe(5);
  });
});
