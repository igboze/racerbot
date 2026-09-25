/**
 * Extensible launchpad framework for custom token launchpads
 * Currently supports: NearlyTrade, Intear, OneTokenHub
 * Can be extended for: Gaypad, and other custom launchpads
 */

export interface LaunchpadPool {
  poolId: string | number;
  tokenAddress: string;
  pairedToken: string;
  reserveNear: string;
  reserveToken: string;
  price: number;
  liquidityNear: number;
  venue: string;
}

export interface LaunchpadConfig {
  factoryContract: string;
  getLaunchMethod: string;
  buyMethod: string;
  sellMethod: string;
  pairedToken: string;
}

/**
 * Known launchpad configurations
 */
export const LAUNCHPAD_CONFIGS: Record<string, LaunchpadConfig> = {
  nearlytrade: {
    factoryContract: 'nearlytrade.near',
    getLaunchMethod: 'get_launch_by_token',
    buyMethod: 'buy',
    sellMethod: 'sell',
    pairedToken: 'wrap.near',
  },
  intear: {
    factoryContract: 'launch.intear.near',
    getLaunchMethod: 'get_launch_data',
    buyMethod: 'buy',
    sellMethod: 'sell',
    pairedToken: 'wrap.near',
  },
  onetokenhub: {
    factoryContract: 'pad.onetokenhub.near',
    getLaunchMethod: 'get_launch_by_token',
    buyMethod: 'buy',
    sellMethod: 'sell',
    pairedToken: 'wrap.near',
  },
  // gaypad: {
  //   factoryContract: 'gaypad.near', // TODO: Update with actual contract
  //   getLaunchMethod: 'get_launch_by_token',
  //   buyMethod: 'buy',
  //   sellMethod: 'sell',
  //   pairedToken: 'wrap.near',
  // },
};

/**
 * Get launchpad configuration by venue name
 */
export function getLaunchpadConfig(venue: string): LaunchpadConfig | null {
  return LAUNCHPAD_CONFIGS[venue] || null;
}

/**
 * Check if a venue is a launchpad
 */
export function isLaunchpadVenue(venue: string): boolean {
  return venue in LAUNCHPAD_CONFIGS;
}

/**
 * Register a custom launchpad configuration
 * Use this to add new launchpads like gaypad
 */
export function registerLaunchpad(name: string, config: LaunchpadConfig): void {
  LAUNCHPAD_CONFIGS[name] = config;
}
