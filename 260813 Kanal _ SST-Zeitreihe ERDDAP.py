#!/usr/bin/env python3
"""
Wassertemperatur Ärmelkanal (Dover Strait / Kanalschwimm-Route)
Monatsmittel pro Jahr, letzte ~11 Jahre.

Quelle: NASA JPL MUR SST v4.1, L4-Analyse, 0.01 Grad, Monatskomposite,
        bereitgestellt via NOAA ERDDAP (kein Account, kein Key notwendig).
Dataset: jplMURSST41mday

Warum MUR und nicht NOAA OISST:
  OISST hat 0.25 Grad (~28 km). Der Kanal ist an der engsten Stelle 33 km breit -
  eine OISST-Zelle mischt dort Wasser und Land. MUR mit 1 km loest die Route
  sauber auf. Fuer eine echte Klimatologie-Diskussion (Trend ueber 30 Jahre)
  waere die Copernicus-Reprocessed-Reihe (SST_ATL_SST_L4_REP_OBSERVATIONS_010_026,
  0.05 Grad, klimaqualitaetsgesichert) die bessere Wahl - dafuer braucht es
  einen kostenlosen Copernicus-Marine-Account.

Installation:
    pip install pandas matplotlib requests

Aufruf:
    python "260813 Kanal | SST-Zeitreihe ERDDAP.py"
"""

import io
import sys

import matplotlib.pyplot as plt
import pandas as pd
import requests

# --- Konfiguration ---------------------------------------------------------

# Box entlang der klassischen Route Shakespeare Beach (51.11 N / 1.30 E)
# bis Cap Gris-Nez (50.87 N / 1.58 E), leicht nach Osten erweitert,
# weil die Tide den Schwimmer in einem S-Bogen nach Nordost und Sued traegt.
LAT_MIN, LAT_MAX = 50.85, 51.15
LON_MIN, LON_MAX = 1.30, 1.95

START = "2015-01-16"


# Stride: 5 => alle 0.05 Grad ein Gitterpunkt. Reicht voellig fuer ein
# Flaechenmittel und haelt den Download bei wenigen MB.
STRIDE = 5

BASE = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41mday.csv"
QUERY = (
    f"?sst[({START}):1:last]"
    f"[({LAT_MIN}):{STRIDE}:({LAT_MAX})]"
    f"[({LON_MIN}):{STRIDE}:({LON_MAX})]"
)

# --- Download --------------------------------------------------------------

url = BASE + QUERY
print(f"Lade: {url}", file=sys.stderr)
r = requests.get(url, timeout=300)
r.raise_for_status()

# ERDDAP liefert Zeile 1 = Spaltennamen, Zeile 2 = Einheiten -> skippen
df = pd.read_csv(io.StringIO(r.text), skiprows=[1])
df.columns = [c.strip() for c in df.columns]
df = df.rename(columns={"sst": "temp"}).dropna(subset=["temp"])

# MUR liefert Kelvin oder Celsius je nach Dataset-Variante -> robust umrechnen
if df["temp"].median() > 100:
    df["temp"] = df["temp"] - 273.15

df["time"] = pd.to_datetime(df["time"])
df["year"] = df["time"].dt.year
df["month"] = df["time"].dt.month

# Flaechenmittel pro Monat
monthly = df.groupby(["year", "month"])["temp"].mean().reset_index()
pivot = monthly.pivot(index="month", columns="year", values="temp")

pivot.to_csv("kanal_sst_monatsmittel.csv")
print(pivot.round(2).to_string(), file=sys.stderr)

# --- Plot 1: Spaghetti, ein Linienzug pro Jahr -----------------------------

MONTHS = [
    "Jan",
    "Feb",
    "Mär",
    "Apr",
    "Mai",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Okt",
    "Nov",
    "Dez",
]

fig, ax = plt.subplots(figsize=(11, 6.5))
years = sorted(pivot.columns)
cmap = plt.get_cmap("YlOrRd")

for i, y in enumerate(years):
    is_last = y == years[-1]
    ax.plot(
        pivot.index,
        pivot[y],
        color=cmap(0.25 + 0.7 * i / max(len(years) - 1, 1)),
        linewidth=3.0 if is_last else 1.6,
        alpha=1.0 if is_last else 0.85,
        marker="o" if is_last else None,
        markersize=4,
        label=str(y),
        zorder=5 if is_last else 2,
    )

# Median aller Jahre als Referenz
ax.plot(
    pivot.index,
    pivot.median(axis=1),
    color="#333333",
    linewidth=2.2,
    linestyle="--",
    label="Median",
    zorder=4,
)

# Schwimmfenster CSA/CSPF: Juni bis September
ax.axvspan(6, 9, color="#E8B93B", alpha=0.13, zorder=0)
ax.text(
    7.5,
    ax.get_ylim()[0] + 0.3,
    "Schwimmfenster",
    ha="center",
    fontsize=9,
    color="#7a6420",
)

ax.set_xticks(range(1, 13))
ax.set_xticklabels(MONTHS)
ax.set_ylabel("Wassertemperatur [°C]")
ax.set_title(
    "Ärmelkanal / Dover Strait — Monatsmittel Wassertemperatur\n"
    "MUR SST v4.1 (1 km), Flächenmittel Route Dover–Cap Gris-Nez",
    loc="left",
    fontsize=12,
)
ax.grid(alpha=0.25)
ax.legend(ncol=2, fontsize=8, frameon=False, loc="upper left")
fig.tight_layout()
fig.savefig("kanal_sst_spaghetti.png", dpi=160)

# --- Plot 2: Heatmap Jahr x Monat ------------------------------------------

fig2, ax2 = plt.subplots(figsize=(9, 6))
data = pivot.T  # Zeilen = Jahre, Spalten = Monate
im = ax2.imshow(data.values, aspect="auto", cmap="RdYlBu_r")
ax2.set_xticks(range(12))
ax2.set_xticklabels(MONTHS)
ax2.set_yticks(range(len(data.index)))
ax2.set_yticklabels(data.index)

for iy in range(data.shape[0]):
    for ix in range(data.shape[1]):
        v = data.values[iy, ix]
        if pd.notna(v):
            ax2.text(ix, iy, f"{v:.1f}", ha="center", va="center", fontsize=7)

fig2.colorbar(im, ax=ax2, label="°C")
ax2.set_title("Wassertemperatur Ärmelkanal — Jahr × Monat", loc="left")
fig2.tight_layout()
fig2.savefig("kanal_sst_heatmap.png", dpi=160)

print(
    "Fertig: kanal_sst_monatsmittel.csv, kanal_sst_spaghetti.png, "
    "kanal_sst_heatmap.png"
)
