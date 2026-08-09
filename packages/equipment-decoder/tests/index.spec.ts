import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  decodeCapacityFromModel,
  normalizeModel,
} from '../src/index.js';

describe('equipment decoder', () => {
  it('normalizes model strings for consistent matching', () => {
    expect(normalizeModel(' gsx13-036-1a ')).toBe('GSX130361A');
    expect(normalizeModel('AMV80 805 CN')).toBe('AMV80805CN');
  });

  it('extracts tonnage from Goodman/Amana cooling model codes', () => {
    const decoded = decodeCapacityFromModel('GSX130361', {
      manufacturer: 'GOODMAN',
    });

    expect(decoded.tonnage).toBe(3);
    expect(decoded.confidence).toBeGreaterThanOrEqual(0.7);
    expect(decoded.evidence.selectedTonnageToken).toBe('36');
  });

  it('extracts furnace BTU from Goodman/Amana furnace model codes', () => {
    const decoded = decodeCapacityFromModel('AMV80805CN', {
      manufacturer: 'AMANA',
    });

    expect(decoded.btu).toBe(80_000);
    expect(decoded.confidence).toBeGreaterThanOrEqual(0.75);
    expect(decoded.evidence.selectedBtuToken).toBe('080');
  });

  it('returns low confidence when model does not contain known capacity markers', () => {
    const decoded = decodeCapacityFromModel('MODELXYZ');

    expect(decoded.tonnage).toBeUndefined();
    expect(decoded.btu).toBeUndefined();
    expect(decoded.confidence).toBeLessThan(0.5);
  });
});
