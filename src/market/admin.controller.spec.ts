import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import type { AdminActivityRepository, WalletActionRow } from './admin-activity.repository';
import type { MarketRepository } from './market.repository';
import type { PerpetualRepository } from './perpetual.repository';
import type { EmailAuthRepository } from './email-auth.repository';
import type { StellarService } from './stellar.service';
import type { ConfigService } from '@nestjs/config';

/**
 * Same regression-shape as `market.controller.guard.spec.ts` — a
 * class-level `@UseGuards(AdminGuard)` silently dropped in a refactor
 * wouldn't show up as a failing request in dev, just an unauthenticated
 * dashboard API. Asserted on the class itself since the guard here is
 * applied once at the controller level, not per-method.
 */
describe('AdminController — every route stays admin-guarded', () => {
  it('carries AdminGuard at the controller level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminController) ?? [];
    expect(guards).toContain(AdminGuard);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(
  overrides: Partial<WalletActionRow> = {},
): WalletActionRow {
  return {
    id: 1,
    contract_id: 'CA',
    wallet_address: 'GX',
    function: 'buy',
    collateral_amount: '1000000',
    fee_bps: 100,
    tx_hash: 'abc',
    source: 'passkey',
    created_at: Date.now(),
    ...overrides,
  };
}

function makeController({
  rows = [] as WalletActionRow[],
  vaultContract = undefined as string | undefined,
  vaultBalance = 0n,
  oracleXlm = null as bigint | null,
  deployerXlm = null as bigint | null,
} = {}) {
  const config = {
    get: (key: string) => {
      if (key === 'vaultContract') return vaultContract;
      if (key === 'oracleMinBalanceStroops') return 10_000_000n;
      return undefined;
    },
  } as unknown as ConfigService;

  const activity = {
    getWalletActionsByFunction: jest.fn().mockReturnValue(rows),
    getAll: jest.fn().mockReturnValue([]),
    countWalletActions: jest.fn().mockReturnValue(0),
    countSettlementChecksByOutcome: jest.fn().mockReturnValue({}),
    getRecentSettlementChecks: jest.fn().mockReturnValue([]),
    getRecentVaultFlows: jest.fn().mockReturnValue([]),
    getDistinctWalletAddresses: jest.fn().mockReturnValue([]),
  } as unknown as AdminActivityRepository;

  const markets = {
    getAll: jest.fn().mockReturnValue([]),
  } as unknown as MarketRepository;

  const perpetuals = {
    getAll: jest.fn().mockReturnValue([]),
  } as unknown as PerpetualRepository;

  const emailWallets = {} as unknown as EmailAuthRepository;

  const stellar = {
    oraclePublicKey: 'GORACLE',
    deployerPublicKey: 'GDEPLOYER',
    vaultBalance: jest.fn().mockResolvedValue(vaultBalance),
    vaultTotalDeposited: jest.fn().mockResolvedValue(0n),
    getNetworkHealth: jest.fn().mockResolvedValue({ status: 'healthy', latestLedger: 1, oldestLedger: 0, ledgerRetentionWindow: 100 }),
    getAccountXlmBalance: jest.fn().mockImplementation((pk: string) => {
      if (pk === 'GORACLE') return Promise.resolve(oracleXlm);
      return Promise.resolve(deployerXlm);
    }),
    getVaultFlows: jest.fn().mockReturnValue([]),
  } as unknown as StellarService;

  const ctrl = new AdminController(config, markets, perpetuals, emailWallets, activity, stellar);
  return { ctrl, activity, stellar };
}

// ---------------------------------------------------------------------------
// Issue #169 — feeRevenue bigint math and null-row skipping
// ---------------------------------------------------------------------------

describe('AdminController.feeRevenue', () => {
  it('sums fees across two markets correctly', () => {
    // CA: buy 1_000_000 @ 100 bps = 10_000; sell 2_000_000 @ 50 bps = 10_000 → 20_000
    // CB: buy 500_000 @ 200 bps = 10_000
    const rows = [
      makeRow({ contract_id: 'CA', function: 'buy', collateral_amount: '1000000', fee_bps: 100 }),
      makeRow({ contract_id: 'CA', function: 'sell', collateral_amount: '2000000', fee_bps: 50 }),
      makeRow({ contract_id: 'CB', function: 'buy', collateral_amount: '500000', fee_bps: 200 }),
    ];
    const { ctrl } = makeController({ rows });
    const result = ctrl.feeRevenue();
    expect(result.totalStroops).toBe('30000');
    const byMarket = Object.fromEntries(result.byMarket.map((e) => [e.contractId, e.stroops]));
    expect(byMarket['CA']).toBe('20000');
    expect(byMarket['CB']).toBe('10000');
  });

  it('skips rows with null fee_bps', () => {
    const rows = [
      makeRow({ contract_id: 'CA', collateral_amount: '1000000', fee_bps: 100 }),
      makeRow({ contract_id: 'CA', collateral_amount: '1000000', fee_bps: null }),
    ];
    const { ctrl } = makeController({ rows });
    const result = ctrl.feeRevenue();
    expect(result.totalStroops).toBe('10000');
  });

  it('skips rows with null collateral_amount', () => {
    const rows = [
      makeRow({ collateral_amount: null, fee_bps: 100 }),
      makeRow({ collateral_amount: '1000000', fee_bps: 100 }),
    ];
    const { ctrl } = makeController({ rows });
    const result = ctrl.feeRevenue();
    expect(result.totalStroops).toBe('10000');
  });

  it('applies floor division on fractional fee', () => {
    // 10_001 * 100 / 10_000 = 100.01 → floor → 100
    const rows = [makeRow({ collateral_amount: '10001', fee_bps: 100 })];
    const { ctrl } = makeController({ rows });
    const result = ctrl.feeRevenue();
    expect(result.totalStroops).toBe('100');
  });

  it('sampleSize counts ALL rows including skipped ones', () => {
    // sampleSize reflects how many rows were queried, not how many contributed
    // to the total — callers can use it to flag a stale/partial sample.
    const rows = [
      makeRow({ collateral_amount: '1000000', fee_bps: 100 }),
      makeRow({ collateral_amount: null, fee_bps: null }),
    ];
    const { ctrl } = makeController({ rows });
    const result = ctrl.feeRevenue();
    expect(result.sampleSize).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Issue #170 — parseLimit bounds and unconfigured-vault branches
// ---------------------------------------------------------------------------

describe('parseLimit via AdminController.settlementChecks', () => {
  function limitUsed(limit: string | undefined): number {
    const { ctrl, activity } = makeController();
    ctrl.settlementChecks(limit);
    return (activity.getRecentSettlementChecks as jest.Mock).mock.calls[0][0] as number;
  }

  it('uses default 50 when limit is undefined', () => {
    expect(limitUsed(undefined)).toBe(50);
  });

  it('uses default 50 for "0"', () => {
    expect(limitUsed('0')).toBe(50);
  });

  it('uses default 50 for "-1"', () => {
    expect(limitUsed('-1')).toBe(50);
  });

  it('uses default 50 for "abc"', () => {
    expect(limitUsed('abc')).toBe(50);
  });

  it('uses default 50 for "501"', () => {
    expect(limitUsed('501')).toBe(50);
  });

  it('uses default 50 for "1.5" (non-integer)', () => {
    expect(limitUsed('1.5')).toBe(50);
  });

  it('accepts "500" as 500', () => {
    expect(limitUsed('500')).toBe(500);
  });

  it('accepts "1" as 1', () => {
    expect(limitUsed('1')).toBe(1);
  });
});

describe('AdminController.overview — unconfigured vault', () => {
  it('returns null vaultBalanceStroops without calling StellarService', async () => {
    const { ctrl, stellar } = makeController({ vaultContract: undefined });
    const result = await ctrl.overview();
    expect(result.vaultBalanceStroops).toBeNull();
    expect((stellar.vaultBalance as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe('AdminController.treasury — unconfigured vault', () => {
  it('returns { configured: false } without calling StellarService', async () => {
    const { ctrl, stellar } = makeController({ vaultContract: undefined });
    const result = await ctrl.treasury();
    expect(result).toEqual({ configured: false });
    expect((stellar.vaultBalance as jest.Mock)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Issue #163 — network endpoint exposes oracle/deployer XLM balances
// ---------------------------------------------------------------------------

describe('AdminController.network — XLM balances', () => {
  it('includes oracleXlmStroops and deployerXlmStroops in the response', async () => {
    const { ctrl } = makeController({ oracleXlm: 50_000_000n, deployerXlm: 20_000_000n });
    const result = await ctrl.network();
    expect(result.oracleXlmStroops).toBe('50000000');
    expect(result.deployerXlmStroops).toBe('20000000');
  });

  it('returns null when NATIVE_XLM_SAC is not configured', async () => {
    const { ctrl } = makeController({ oracleXlm: null, deployerXlm: null });
    const result = await ctrl.network();
    expect(result.oracleXlmStroops).toBeNull();
    expect(result.deployerXlmStroops).toBeNull();
  });

  it('warns when oracle balance is below the minimum', async () => {
    const { ctrl } = makeController({ oracleXlm: 5_000_000n, deployerXlm: 50_000_000n });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warnSpy = jest.spyOn((ctrl as any).logger, 'warn');
    await ctrl.network();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('oracle account'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('deployer account'));
  });
});
