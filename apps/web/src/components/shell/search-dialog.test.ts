import { describe, expect, it } from 'vitest';
import { isSearchShortcut } from './search-dialog';

const key = (k: string, over: Partial<Parameters<typeof isSearchShortcut>[0]> = {}) =>
  isSearchShortcut({ key: k, ctrlKey: false, metaKey: false, altKey: false, target: { tagName: 'BODY' }, ...over });

describe('search keyboard shortcut', () => {
  it('[S1-10] keyboard shortcuts for search: / outside fields, Ctrl+K and Cmd+K anywhere', () => {
    expect(key('/')).toBe(true);
    expect(key('k', { ctrlKey: true })).toBe(true);
    expect(key('K', { metaKey: true })).toBe(true);
    // Typing a slash into a field, or the browser's own shortcuts, never open search.
    expect(key('/', { target: { tagName: 'INPUT' } })).toBe(false);
    expect(key('/', { target: { tagName: 'TEXTAREA' } })).toBe(false);
    expect(key('/', { target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
    expect(key('k', { ctrlKey: true, target: { tagName: 'INPUT' } })).toBe(true);
    expect(key('k')).toBe(false);
    expect(key('k', { ctrlKey: true, altKey: true })).toBe(false);
    expect(key('/', { ctrlKey: true })).toBe(false);
  });
});
