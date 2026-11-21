import { BadRequestException } from '@nestjs/common';
import { PerpetualController } from './perpetual.controller';
import type { PerpetualService } from './perpetual.service';
import type { StellarService } from './stellar.service';
import type { OracleService } from './oracle.service';
import type { AdminActivityRepository } from './admin-activity.repository';
import type { ConfigService } from '@nestjs/config';
/**
 * Regression for `buildPriceOracleParams`'s all-or-nothing rule:
 * the full Lazer+Reflector+RedStone bundle is passed to `deployPerpetual`
 * only when ALL THREE contracts are configured — a half-wired bundle is
 * rejected by `initialize` on-chain, so this enforces that no partial
 * config silently sneaks through.
 */
describe('PerpetualController.create — buildPriceOracleParams all-or-nothing', () => {
  const BASE_ENV: Record<string, unknown> = {
    nativeXlmSac: 'CXLM',
    lazerContract: 'CLAZER',
    reflectorContract: 'CREFLECTOR',
    mockRedstoneContract: 'CREDSTONE',
    xlmUsdFeedId: 7,
    reflectorAsset: 'native',
    reflectorMaxStalenessSecs: '300',
    reflectorToleranceBps: 150,
    redstoneMaxStalenessSecs: '600',
    redstoneToleranceBps: 150,
    treasuryAddress: undefined,
  };

  function makeController(envOverrides: Record<string, unknown> = {}) {
    const env = { ...BASE_ENV, ...envOverrides };

    const config = {
      get: (key: string) => env[key],
    } as unknown as ConfigService;

    const deployPerpetual = jest.fn().mockResolvedValue({ contractId: 'CPERP', initTxHash: 'TX1' });
    const stellar = {
      oraclePublicKey: 'GORACLE',
      deployPerpetual,
    } as unknown as StellarService;

    const perpetualService = {
      watch: jest.fn().mockReturnValue({ contractId: 'CPERP', status: 'watching' }),
      list: jest.fn().mockReturnValue([]),
    } as unknown as PerpetualService;

    const oracle = {} as unknown as OracleService;
    const activity = {} as unknown as AdminActivityRepository;

    const ctrl = new PerpetualController(perpetualService, stellar, oracle, config, activity);
    return { ctrl, deployPerpetual, perpetualService };
  }

  const dto = { baseFeeBps: 100, minFeeBps: 20, initialLiquidityStroops: '1000000000' };

  it('passes full priceOracle bundle when all three contracts are configured', async () => {
    const { ctrl, deployPerpetual } = makeController();
    await ctrl.create(dto);
    const args = deployPerpetual.mock.calls[0][0];
    expect(args.priceOracle).not.toBeUndefined();
    expect(args.priceOracle.lazerContract).toBe('CLAZER');
    expect(args.priceOracle.reflectorContract).toBe('CREFLECTOR');
    expect(args.priceOracle.redstoneContract).toBe('CREDSTONE');
  });

  it('passes priceOracle: undefined when LAZER_CONTRACT is missing', async () => {
    const { ctrl, deployPerpetual } = makeController({ lazerContract: undefined });
    await ctrl.create(dto);
    expect(deployPerpetual.mock.calls[0][0].priceOracle).toBeUndefined();
  });

  it('passes priceOracle: undefined when REFLECTOR_CONTRACT is missing', async () => {
    const { ctrl, deployPerpetual } = makeController({ reflectorContract: undefined });
    await ctrl.create(dto);
    expect(deployPerpetual.mock.calls[0][0].priceOracle).toBeUndefined();
  });

  it('passes priceOracle: undefined when MOCK_REDSTONE_CONTRACT is missing', async () => {
    const { ctrl, deployPerpetual } = makeController({ mockRedstoneContract: undefined });
    await ctrl.create(dto);
    expect(deployPerpetual.mock.calls[0][0].priceOracle).toBeUndefined();
  });

  it('throws BadRequestException when NATIVE_XLM_SAC is not configured', async () => {
    const { ctrl } = makeController({ nativeXlmSac: undefined });
    await expect(ctrl.create(dto)).rejects.toBeInstanceOf(BadRequestException);
  });
});
