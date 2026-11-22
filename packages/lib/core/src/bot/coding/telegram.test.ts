import { describe, expect, it } from 'vitest';
import { TELEGRAM_MESSAGE_LIMIT, splitTelegramMessage } from './telegram';

describe('splitTelegramMessage', () => {
    it('keeps short messages intact', () => {
        expect(splitTelegramMessage('hello')).toEqual(['hello']);
        expect(splitTelegramMessage('')).toEqual(['']);
    });

    it('splits long text at newlines without losing content', () => {
        const text = Array.from({ length: 800 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
        const parts = splitTelegramMessage(text);
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.every(part => part.length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true);
        expect(parts.join('')).toBe(text);
    });

    it('falls back to spaces and hard limits for unbroken text', () => {
        const words = Array.from({ length: 5000 }, () => 'word').join(' ');
        const parts = splitTelegramMessage(words, 100);
        expect(parts.every(part => part.length <= 100)).toBe(true);
        expect(parts.join('')).toBe(words);

        const hard = 'x'.repeat(1000);
        const hardParts = splitTelegramMessage(hard, 128);
        expect(hardParts.every(part => part.length <= 128)).toBe(true);
        expect(hardParts.join('')).toBe(hard);
    });
});
