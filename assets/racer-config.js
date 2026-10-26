/**
 * RACER PROTOCOL & FRONTEND CENTRALIZED CONFIGURATION (PART 7)
 * Single source of truth for platform constants, fee math, tiers, and limits.
 */
(function() {
  const config = {
    // 6.3.2 Viewing key tiers (30-day one-time payment)
    tierPrices: {
      view: 1.5,
      copy: 3.5,
      pro: 8.0,
      currency: 'NEAR',
      durationDays: 30
    },
    tierDescriptions: {
      view: 'Public equity curve, key performance stats, limited position preview.',
      copy: 'Full position details, real-time copy following, trade notifications.',
      pro: 'Everything in Copy, strategy insights, priority support.'
    },
    tierPermissions: {
      view: 'Lets you see this trader\'s positions. It does not give access to your funds.',
      copy: 'Lets you see positions and enables auto-copy. Auto-copy places trades from your balance within the limits you set. You can turn it off any time.',
      pro: 'Lets you see positions and enables auto-copy. Auto-copy places trades from your balance within the limits you set. You can turn it off any time.'
    },

    // Revenue split
    revenueSplit: {
      creatorPct: 90,
      platformPct: 10
    },

    // Creator Studio (6.3.7)
    creator: {
      registrationFeeNear: 5.0,
      treasuryAccount: 'racerbottreasury.near',
      volumeGateUsd: 10000,
      strategyFocusOptions: [
        'Bonding Curve Sniper',
        'Trend Following',
        'Launchpad Breakout',
        'Microcap DCA',
        'Confidential Intent Arbitrage'
      ]
    },

    // RacerFleet (6.4)
    fleet: {
      tiers: {
        viper: {
          key: 'viper',
          name: 'Viper',
          wallets: 5,
          priceNear: 2.0,
          desc: '5 wallets. Spread entries across launchpad bonding curves.'
        },
        falcon: {
          key: 'falcon',
          name: 'Falcon',
          wallets: 10,
          priceNear: 3.5,
          desc: '10 wallets. Parallel entries across Ref Finance and NearlyTrade.'
        },
        apex: {
          key: 'apex',
          name: 'Apex',
          wallets: 25,
          priceNear: 7.0,
          desc: '25 wallets. Large-scale distribution across many wallets.'
        }
      },
      platformFeeRate: 0.015, // 1.5%
      defaultDelayMs: 400,
      buySlippageOptions: [1.0, 3.0, 5.0, 10.0],
      sellSlippageOptions: [1.0, 3.0, 5.0],
      perWalletAmounts: [0.5, 1.0, 2.5, 5.0]
    },

    // Racer Alpha Console (6.3.3)
    console: {
      quickAmounts: [0.5, 1.0, 2.5, 5.0, 10, 25],
      slippageOptions: [0.5, 1.0, 2.5, 5.0]
    },

    // Copy Trading Safety Defaults (6.3.5)
    copyTradingDefaults: {
      allocationPct: 5,
      riskMultiplier: 1.0,
      stopLossPct: -8,
      highExposureThresholdPct: 20
    },

    // RacerBubble (6.2)
    bubble: {
      quickBuyAmounts: [1, 5, 10]
    },

    // Arena Points (6.5)
    points: {
      perNearTraded: 100,
      firstTradeBonus: 500,
      sniperBonus: 250,
      referralSignupBonus: 1000,
      referralPointsMatchPct: 20
    },

    // Referral Commission (Part 9 Open Question 1 resolved to canonical 20%)
    referralCommissionPct: 20,

    // Featured Sprint (6.5)
    featuredSprint: {
      token: 'KOOKDOG',
      targetMarketCap: 29000
    },

    // Limits
    maxCopyKeys: 5,

    // Filters
    launchpadFilters: ['All', 'JustHoot', 'NearlyTrade', 'Meme.Cooking', 'NearPad', 'Shore', 'Ref DEX', 'InTear'],
    strategyFilters: ['All', 'Trend Following', 'Quant', 'Discretionary', 'DeFi Yield', 'Arbitrage', 'Macro', 'Confidential Snipe'],
    riskFilters: ['All', 'Low', 'Low-Medium', 'Medium', 'Medium-High'],
    sortOptions: ['ROI', 'Win rate', 'Followers']
  };

  if (typeof window !== 'undefined') {
    window.RACER_CONFIG = config;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = config;
  }
})();
