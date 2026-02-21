const CAPTURE_PROFILES = Object.freeze({
  light: Object.freeze({
    snapshot: Object.freeze({
      low: Object.freeze({
        maxChars: 6000,
        maxLinks: 30,
        includeHeadings: false,
        includeFormsSummary: false
      }),
      high: Object.freeze({
        maxChars: 9000,
        maxLinks: 45,
        includeHeadings: true,
        includeFormsSummary: true
      })
    }),
    list: Object.freeze({
      low: Object.freeze({
        maxItems: 120,
        maxTextChars: 80,
        interactiveOnly: true,
        visibleOnly: true,
        viewportOnly: true,
        includeSelectors: false
      }),
      high: Object.freeze({
        maxItems: 180,
        maxTextChars: 120,
        interactiveOnly: true,
        visibleOnly: true,
        viewportOnly: false,
        includeSelectors: true
      })
    }),
    query_dom: Object.freeze({
      low: Object.freeze({
        limit: 20,
        maxChars: 180,
        includeText: true,
        includeValue: false,
        includeBBox: false,
        includeVisibility: true,
        includeState: false,
        includeTagName: true,
        maxPayloadBytes: 120000
      }),
      high: Object.freeze({
        limit: 40,
        maxChars: 400,
        includeText: true,
        includeValue: true,
        includeBBox: false,
        includeVisibility: true,
        includeState: true,
        includeTagName: true,
        maxPayloadBytes: 180000
      })
    }),
    take_snapshot: Object.freeze({
      low: Object.freeze({
        interestingOnly: true,
        maxNodes: 220,
        maxNameChars: 80,
        interactiveOnly: true,
        visibleOnly: true,
        maxDepth: 10
      }),
      high: Object.freeze({
        interestingOnly: true,
        maxNodes: 320,
        maxNameChars: 120,
        interactiveOnly: false,
        visibleOnly: false,
        maxDepth: 14
      })
    }),
    visual_snapshot: Object.freeze({
      low: Object.freeze({
        fullPage: false,
        viewportOnly: true,
        interactiveOnly: true,
        visibleOnly: true,
        maxItems: 80,
        maxTextChars: 60,
        includeText: false,
        includeSelectors: false
      }),
      high: Object.freeze({
        fullPage: false,
        viewportOnly: false,
        interactiveOnly: true,
        visibleOnly: true,
        maxItems: 120,
        maxTextChars: 100,
        includeText: true,
        includeSelectors: true
      })
    })
  }),
  balanced: Object.freeze({
    snapshot: Object.freeze({
      low: Object.freeze({
        maxChars: 12000,
        maxLinks: 60,
        includeHeadings: true,
        includeFormsSummary: true
      }),
      high: Object.freeze({
        maxChars: 16000,
        maxLinks: 80,
        includeHeadings: true,
        includeFormsSummary: true
      })
    }),
    list: Object.freeze({
      low: Object.freeze({
        maxItems: 240,
        maxTextChars: 120,
        interactiveOnly: true,
        visibleOnly: true,
        viewportOnly: false,
        includeSelectors: true
      }),
      high: Object.freeze({
        maxItems: 320,
        maxTextChars: 160,
        interactiveOnly: true,
        visibleOnly: true,
        viewportOnly: false,
        includeSelectors: true
      })
    }),
    query_dom: Object.freeze({
      low: Object.freeze({
        limit: 40,
        maxChars: 400,
        includeText: true,
        includeValue: true,
        includeBBox: false,
        includeVisibility: true,
        includeState: true,
        includeTagName: true,
        maxPayloadBytes: 180000
      }),
      high: Object.freeze({
        limit: 70,
        maxChars: 700,
        includeText: true,
        includeValue: true,
        includeBBox: true,
        includeVisibility: true,
        includeState: true,
        includeTagName: true,
        maxPayloadBytes: 250000
      })
    }),
    take_snapshot: Object.freeze({
      low: Object.freeze({
        interestingOnly: true,
        maxNodes: 440,
        maxNameChars: 120,
        interactiveOnly: true,
        visibleOnly: true,
        maxDepth: 12
      }),
      high: Object.freeze({
        interestingOnly: true,
        maxNodes: 700,
        maxNameChars: 160,
        interactiveOnly: false,
        visibleOnly: false,
        maxDepth: 18
      })
    }),
    visual_snapshot: Object.freeze({
      low: Object.freeze({
        fullPage: false,
        viewportOnly: false,
        interactiveOnly: true,
        visibleOnly: true,
        maxItems: 160,
        maxTextChars: 100,
        includeText: true,
        includeSelectors: true
      }),
      high: Object.freeze({
        fullPage: true,
        viewportOnly: false,
        interactiveOnly: true,
        visibleOnly: true,
        maxItems: 240,
        maxTextChars: 140,
        includeText: true,
        includeSelectors: true
      })
    })
  }),
  full: Object.freeze({
    snapshot: Object.freeze({
      low: Object.freeze({
        maxChars: 20000,
        maxLinks: 100,
        includeHeadings: true,
        includeFormsSummary: true
      }),
      high: Object.freeze({
        maxChars: 20000,
        maxLinks: 100,
        includeHeadings: true,
        includeFormsSummary: true
      })
    }),
    list: Object.freeze({
      low: Object.freeze({
        maxItems: 500,
        maxTextChars: 200,
        interactiveOnly: false,
        visibleOnly: true,
        viewportOnly: false,
        includeSelectors: true
      }),
      high: Object.freeze({
        maxItems: 500,
        maxTextChars: 300,
        interactiveOnly: false,
        visibleOnly: false,
        viewportOnly: false,
        includeSelectors: true
      })
    }),
    query_dom: Object.freeze({
      low: Object.freeze({
        limit: 120,
        maxChars: 1200,
        includeText: true,
        includeValue: true,
        includeBBox: true,
        includeVisibility: true,
        includeState: true,
        includeTagName: true,
        maxPayloadBytes: 350000
      }),
      high: Object.freeze({
        limit: 200,
        maxChars: 2000,
        includeText: true,
        includeValue: true,
        includeBBox: true,
        includeVisibility: true,
        includeState: true,
        includeTagName: true,
        maxPayloadBytes: 450000
      })
    }),
    take_snapshot: Object.freeze({
      low: Object.freeze({
        interestingOnly: true,
        maxNodes: 1200,
        maxNameChars: 180,
        interactiveOnly: false,
        visibleOnly: false,
        maxDepth: 24
      }),
      high: Object.freeze({
        interestingOnly: false,
        maxNodes: 2000,
        maxNameChars: 220,
        interactiveOnly: false,
        visibleOnly: false,
        maxDepth: 32
      })
    }),
    visual_snapshot: Object.freeze({
      low: Object.freeze({
        fullPage: true,
        viewportOnly: false,
        interactiveOnly: false,
        visibleOnly: true,
        maxItems: 300,
        maxTextChars: 160,
        includeText: true,
        includeSelectors: true
      }),
      high: Object.freeze({
        fullPage: true,
        viewportOnly: false,
        interactiveOnly: false,
        visibleOnly: false,
        maxItems: 500,
        maxTextChars: 220,
        includeText: true,
        includeSelectors: true
      })
    })
  })
});

function normalizeDetail(detail) {
  return String(detail || 'low').toLowerCase() === 'high' ? 'high' : 'low';
}

export function listCaptureProfiles() {
  return Object.keys(CAPTURE_PROFILES);
}

export function normalizeCaptureProfile(profile) {
  const raw = String(profile || '').trim().toLowerCase();
  if (raw && Object.prototype.hasOwnProperty.call(CAPTURE_PROFILES, raw)) {
    return raw;
  }
  return 'light';
}

export function getCaptureProfile(profile) {
  const key = normalizeCaptureProfile(profile);
  return CAPTURE_PROFILES[key];
}

export function getCaptureDefaults(profile, toolName, detail = 'low') {
  const profileDef = getCaptureProfile(profile);
  const toolDef = profileDef?.[toolName];
  if (!toolDef) return {};
  const detailKey = normalizeDetail(detail);
  const resolved = toolDef[detailKey] || toolDef.low || {};
  return { ...resolved };
}
