/**
 * Smart Model Router for NanoClaw
 * Routes prompts to appropriate agents based on task complexity
 */

export type AgentName =
  | 'deep-research'
  | 'light-research'
  | 'daily'
  | 'tech-reviewer'
  | 'finance-reviewer'
  | 'health-reviewer'
  | 'language-reviewer'
  | 'science-reviewer';

interface ModelRoute {
  patterns: string[];
  agent: AgentName;
  description: string;
}

// Routing rules (order matters — first match wins)
const MODEL_ROUTES: ModelRoute[] = [
  {
    patterns: [
      'deep-research',
      '>professor',
      '>farnsworth',
    ],
    agent: 'deep-research',
    description: 'Deep research and comprehensive analysis',
  },
  {
    patterns: [
      'tech-review',
      '>amy',
    ],
    agent: 'tech-reviewer',
    description: 'Stress-test research findings for engineering feasibility and architectural fit',
  },
  {
    patterns: [
      'finance-reviewer',
      '>hermes',
    ],
    agent: 'finance-reviewer',
    description: 'Finance, macro-economy, and investment analysis',
  },
  {
    patterns: [
      'health-reviewer',
      '>zoidberg',
    ],
    agent: 'health-reviewer',
    description: 'Health, medical mechanisms, and wellbeing',
  },
  {
    patterns: [
      'language-reviewer',
      '>leela',
    ],
    agent: 'language-reviewer',
    description: 'English language review and grammar correction',
  },
  {
    patterns: [
      'science-reviewer',
      '>nibbler',
    ],
    agent: 'science-reviewer',
    description: 'Scientific explanation via first principles',
  },
  {
    patterns: [
      'light-research',
      '>fry',
    ],
    agent: 'light-research',
    description: 'Light research and information gathering',
  },
];

const DEFAULT_AGENT: AgentName = 'daily';

// OpenRouter model IDs for each agent
export const AGENT_MODELS: Record<AgentName, string> = {
  'deep-research': 'google/gemini-3-flash-preview',
  'light-research': 'google/gemini-2.5-flash',
  'daily': 'google/gemini-2.5-flash-lite',
  'tech-reviewer': 'minimax/minimax-m2.5',
  'finance-reviewer': 'google/gemini-2.5-flash',
  'health-reviewer': 'google/gemini-2.5-flash',
  'language-reviewer': 'google/gemini-2.5-flash',
  'science-reviewer': 'google/gemini-2.5-flash',
};

// Patterns that indicate the user wants to orchestrate a team.
// When detected, always route to the default agent (Bender) so he can
// coordinate, even if agent keywords like ">professor" appear in the prompt.
const TEAM_PATTERNS = [
  'assemble a team',
  'assemble team',
  'team of',
];

/**
 * Route a prompt to the appropriate agent based on content.
 *
 * Team orchestration prompts (e.g., "Assemble team... >professor... >amy")
 * always route to the default agent so it can coordinate via TeamCreate.
 * Agent keywords only trigger routing when they're direct commands to
 * that agent, not when they appear as team member descriptions.
 */
export function routeModel(prompt: string): AgentName {
  // Unescape XML entities — formatMessages escapes > to &gt; etc.
  // Without this, patterns like '>fry' never match user-typed '>fry'.
  const normalizedPrompt = prompt
    .toLowerCase()
    .trim()
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

  // Team orchestration: route to default agent (Bender) so he can coordinate.
  // Without this, "Assemble team... >professor..." would route to the
  // deep-research agent instead of letting the orchestrator handle it.
  if (TEAM_PATTERNS.some(p => normalizedPrompt.includes(p))) {
    return DEFAULT_AGENT;
  }

  for (const route of MODEL_ROUTES) {
    for (const pattern of route.patterns) {
      if (normalizedPrompt.includes(pattern.toLowerCase())) {
        return route.agent;
      }
    }
  }

  return DEFAULT_AGENT;
}

/**
 * Get the OpenRouter model ID for a given agent
 */
export function getModelEnvValue(agent: AgentName): string {
  return AGENT_MODELS[agent];
}

/**
 * Get routing statistics and configuration info
 */
export function getRoutingInfo(): {
  routes: ModelRoute[];
  defaultAgent: AgentName;
} {
  return {
    routes: MODEL_ROUTES,
    defaultAgent: DEFAULT_AGENT,
  };
}
