# Complete Instructions for Skill Seeding

## 🎯 Primary Workflow
Follow: `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/SKILL_SEEDING_WORKFLOW.md`

## 📚 Essential Reading (Start of Each Session)

1. **Get Meta Schema**: 
   ```bash
   node /home/michael/InfiniQuest/yFrameworks/skill-seeding-framework/scripts/get-skills-meta.js
   ```

2. **Core Documentation**:
   - `/home/michael/InfiniQuest/yFrameworks/skill-seeding-framework/SKILL_TEMPLATE_INSTRUCTIONS.md` - What to generate vs calculate
   - `/home/michael/InfiniQuest/yFrameworks/skill-seeding-framework/SKILL_HIERARCHY_GUIDE.md` - Relationship decisions
   - `/home/michael/InfiniQuest/yFrameworks/skill-seeding-framework/documentation/FORMULA_REFERENCE.md` - Component scoring guides (difficulty to be calculated by code, not claude. But claude can help with other values.)

## ✅ Required Fields for Each Skill

### Must Include:
```json
{
  "difficultyComponents": {
    "cognitiveLoad": 1-10,        // Mental effort required
    "timeInvestment": 1-10,       // Time to basic competency
    "prerequisiteCount": 0-10,     // Number of prerequisites
    "physicalRequirements": 1-10,  // Equipment/space needs
    "learningCurve": 1-10         // Steepness of initial learning
  },
  "decay": {
    "skillType": "motor|knowledge|language|creative|social|technical",
    "baseDecayRate": 0.005-0.03   // Use rates from SKILL_DECAY_MAINTENANCE.md
  }
}
```

### Decay Rate Reference:
- **motor**: 0.005 (swimming, typing)
- **knowledge**: 0.02 (facts, formulas)
- **language**: 0.03 (vocabulary)
- **creative**: 0.01 (art style)
- **social**: 0.015 (reading people)
- **technical**: 0.025 (coding)

## 🚀 Workflow Commands

### Claim Skills (with duplicate detection):
```bash
# Multi-domain claim (recommended)
node /home/michael/InfiniQuest/tmp/claudeLoop/dashboard/todo-utils/claim-multi-enhanced.js skills-physical skills-mental skills-emotional skills-creative skills-technical skills-professional skills-practical skills-academic skills-spiritual skills-communication

# Single domain
node todo-utils/todo-client.js claim skills-physical
```

### Complete & Continue:
```bash
# Mark complete
node todo-utils/todo-client.js complete {TODO_ID}

# Claim next
node todo-utils/todo-client.js claim claude-loop8
```

### Insert Skill:
```bash
cd /home/michael/InfiniQuest/yFrameworks/skill-seeding-framework/scripts
node insert-skill-safe.js ../templates/generated/{skill-name}.json
```

## 💡 Key Principles

### What Claude Generates:
- **Component scores** (1-10 values)
- **Lists** (prerequisites, resources, milestones)
- **Descriptions** (whyLearnThis, intrinsicRewards)
- **Relationships** (parents, siblings, etc.)
- **Human insights** (funFactor, emotionalPrerequisites)

### What Code Calculates:
- Difficulty score from components
- Actual decay based on last practice
- Relative difficulty per user
- Momentum states
- Skill strength (Fresh/Rusty/etc.)

### Anti-Manipulation Always:
- No streak pressure
- Celebrate rest
- Progress over perfection
- Your journey is unique
- Skills wait patiently

## 📊 Current Status
- **1,015 skills** in queue across 10 domains
- Focus on **beginner skills** with **wide appeal**
- Each domain has ~100 skills pending

## 🔧 Utilities

### Add Suggestions:
```bash
node todo-utils/todo-client.js add "suggestion text" suggestions
```

### Leave Breadcrumbs:
```bash
node todo-utils/todo-client.js add "task text" task-requests
node todo-utils/todo-client.js add "goal text" goal-requests
```

### Check Progress:
```bash
node todo-utils/todo-client.js stats claude-loop8
```

## 📝 Session Checklist

- [ ] Read meta schema at start
- [ ] Include difficultyComponents (5 values)
- [ ] Include decay field with type & rate
- [ ] Set appropriate relationships
- [ ] Validate anti-manipulation language
- [ ] Save to `/home/michael/InfiniQuest/yFrameworks/skill-seeding-framework/templates/generated`
- [ ] Insert with insert-skill-safe.js
- [ ] Complete todo
- [ ] Claim next, and check for related skills (claim-multi-enhanced enables this)

## 🎯 Quality Targets

- **2-3 minutes** per skill average
- **All required fields** populated
- **Relationships** properly set
- **Component scores** thoughtfully assigned
- **Anti-pressure** philosophy clear

---
*These instructions ensure consistent, high-quality skill creation aligned with the framework*