#!/usr/bin/env python3
"""
Weighted Decision Framework for the three project options.
Criteria are weighted:  Speed 80 %   Reliability 15 %   Cost 5 %
"""

def score():
    # Raw data
    speed = {'A': 180, 'B': 120, 'C': 60}        # days to deliver
    risk  = {'A': 0.30, 'B': 0.10, 'C': 0.01}    # failure probability
    cost  = {'A': 20, 'B': 50, 'C': 100}         # k$

    # Normalise to 0-100 (best = 100, worst = 0)
    worst_b = max(speed.values())
    best_b  = min(speed.values())
    S = {k: 100 - 100*(v - best_b)/(worst_b - best_b) for k,v in speed.items()}

    worst_r = max(risk.values())
    best_r  = min(risk.values())
    R = {k: 100 - 100*(v - best_r)/(worst_r - best_r) for k,v in risk.items()}

    worst_c = max(cost.values())
    best_c  = min(cost.values())
    C = {k: 100 - 100*(v - best_c)/(worst_c - best_c) for k,v in cost.items()}

    WS = 0.80
    WR = 0.15
    WC = 0.05

    scores = {}
    for p in ['A','B','C']:
        scores[p] = round(WS*S[p] + WR*R[p] + WC*C[p], 2)

    print("Sub-scores 0-100")
    for p in ['A','B','C']:
        print(f"{p}: Speed {S[p]:.0f}, Reliability {R[p]:.0f}, Cost {C[p]:.0f}")

    print("\nWeighted Overall Scores (0-100)")
    print(scores)
    
    best = max(scores, key=scores.get)
    print(f"\nChosen project -> {best} with score {scores[best]}")

if __name__ == '__main__':
    score()