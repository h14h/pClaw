"""
Weighted decision framework for three project options under the priority:
Speed (weight 0.5) > Reliability (weight 0.35) > Cost (weight 0.15).
Project data:
A: low cost, high risk (cA=$50k, speed=3 mo)
B: medium cost, medium risk (cB=$100k, speed=4 mo)
C: high cost, low risk (cC=$200k, speed=5 mo)
Score =   0.5*(Speed_norm)           
        + 0.35*(Reliability_norm)
        + 0.15*(1 - Cost_norm)      [so lower cost -> higher score]
norm() linearly maps best→worst in each attribute onto 0..1 range.
"""

import numpy as np

projects = {
    'A': {'cost': 50,  'risk': 'high',   'speed_months': 3},
    'B': {'cost': 100, 'risk': 'medium', 'speed_months': 4},
    'C': {'cost': 200, 'risk': 'low',    'speed_months': 5},
}

risk_score = {'high': 1/3, 'medium': 1/2, 'low': 1}  # reliability = 1/risk

# --- extract arrays for normalisation ---
costs      = [p['cost']         for p in projects.values()]
reliab     = [risk_score[p['risk']] for p in projects.values()]
speeds     = [p['speed_months'] for p in projects.values()]

max_cost, min_cost  = max(costs), min(costs)
max_speed, min_speed = max(speeds), min(speeds)
max_rel, min_rel   = max(reliab), min(reliab)

def norm(val, worst, best):
    return (worst - val) / (worst - best)   # 1 for best, 0 for worst

# --- compute weighted scores ---
w = {'speed': 0.50, 'reliability': 0.35, 'cost': 0.15}
scores = {}
for name, data in projects.items():
    speed_norm = norm(data['speed_months'], max_speed, min_speed)
    rel_norm   = norm(risk_score[data['risk']], min_rel, max_rel)
    cost_norm  = norm(data['cost'], max_cost, min_cost)
    score = w['speed']*speed_norm + w['reliability']*rel_norm + w['cost']*(cost_norm)
    scores[name] = round(score, 4)

if __name__ == "__main__":
    print("Weighted scores =>", scores)
    best = max(scores, key=scores.get)
    print(f"Recommended: Project {best}")