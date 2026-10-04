"""
Tests for the cost model — the numbers that decide if an edge is real.

Every assertion here encodes a rule brokers actually apply: costs always
work against you, swap triples on Wednesday, stops slip more than entries.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from costs import DEFAULT_SWAP_TABLE, CostModel  # noqa: E402

PIP = 0.0001
MON = datetime(2024, 3, 4, 10, 0)   # Monday
TUE = datetime(2024, 3, 5, 10, 0)
THU = datetime(2024, 3, 7, 10, 0)


class TestFills:
    def test_buy_entry_fills_above_requested(self):
        c = CostModel()
        assert c.entry_fill(1.1000, "BUY", PIP) > 1.1000

    def test_sell_entry_fills_below_requested(self):
        c = CostModel()
        assert c.entry_fill(1.1000, "SELL", PIP) < 1.1000

    def test_long_stop_exit_fills_below_requested(self):
        c = CostModel()
        assert c.exit_fill(1.0950, "BUY", PIP, is_stop=True) < 1.0950

    def test_stop_slips_more_than_a_target(self):
        c = CostModel()
        stop = c.exit_fill(1.0950, "BUY", PIP, is_stop=True)
        target = c.exit_fill(1.0950, "BUY", PIP, is_stop=False)
        assert stop < target

    def test_spread_widens_at_rollover(self):
        c = CostModel(spread_pips=1.0, wide_spread_multiplier=3.0)
        assert c.spread_at(datetime(2024, 3, 4, 12)) == 1.0
        assert c.spread_at(datetime(2024, 3, 4, 22)) == 3.0

    def test_zero_model_is_frictionless(self):
        c = CostModel.zero()
        assert c.entry_fill(1.1, "BUY", PIP) == pytest.approx(1.1)
        assert c.swap_charge("BUY", 1.0, MON, THU) == 0.0
        assert c.commission(1.0) == 0.0


class TestSwap:
    def test_intraday_trade_pays_no_swap(self):
        c = CostModel()
        same_day = datetime(2024, 3, 4, 18, 0)
        assert c.nights_held(MON, same_day) == 0
        assert c.swap_charge("BUY", 1.0, MON, same_day) == 0.0

    def test_counts_each_rollover_crossed(self):
        c = CostModel()
        assert c.nights_held(MON, THU) == 3

    def test_wednesday_is_tripled(self):
        """Mon→Thu crosses Mon, Tue and Wed rollovers = 1 + 1 + 3 = 5 charges."""
        c = CostModel(swap_long=-10.0, swap_short=0.0)
        assert c.swap_charge("BUY", 1.0, MON, THU) == pytest.approx(-50.0)

    def test_without_wednesday_no_tripling(self):
        c = CostModel(swap_long=-10.0)
        assert c.swap_charge("BUY", 1.0, MON, TUE) == pytest.approx(-10.0)

    def test_scales_with_lot_size(self):
        c = CostModel(swap_long=-10.0)
        one = c.swap_charge("BUY", 1.0, MON, TUE)
        tenth = c.swap_charge("BUY", 0.1, MON, TUE)
        assert tenth == pytest.approx(one * 0.1)

    def test_long_and_short_differ(self):
        c = CostModel.for_pair("EUR/USD")
        assert c.swap_charge("BUY", 1.0, MON, TUE) != c.swap_charge("SELL", 1.0, MON, TUE)

    def test_disabled_swap_is_zero(self):
        c = CostModel(swap_long=-10.0, swap_enabled=False)
        assert c.swap_charge("BUY", 1.0, MON, THU) == 0.0

    def test_reversed_times_are_safe(self):
        c = CostModel()
        assert c.swap_charge("BUY", 1.0, THU, MON) == 0.0
        assert c.nights_held(THU, MON) == 0


class TestCommissionAndTotals:
    def test_commission_charges_both_sides(self):
        c = CostModel(commission_per_lot_per_side=3.5)
        assert c.commission(1.0) == pytest.approx(7.0)

    def test_total_cost_is_itemised(self):
        c = CostModel.for_pair("EUR/USD")
        items = c.total_cost("BUY", 0.1, MON, THU, PIP)
        assert set(items) >= {"spread_cost", "commission", "swap", "nights", "total_cash"}
        assert items["nights"] == 3.0

    def test_negative_swap_increases_cash_cost(self):
        c = CostModel(swap_long=-10.0, commission_per_lot_per_side=1.0)
        items = c.total_cost("BUY", 1.0, MON, TUE, PIP)
        # commission 2.0 and a 10.0 swap charge → 12.0 deducted
        assert items["total_cash"] == pytest.approx(12.0)

    def test_positive_swap_offsets_cost(self):
        c = CostModel(swap_short=+4.0, commission_per_lot_per_side=1.0)
        items = c.total_cost("SELL", 1.0, MON, TUE, PIP)
        assert items["total_cash"] == pytest.approx(-2.0)


class TestTimestampHandling:
    def test_accepts_pandas_timestamps(self):
        """Mixed tz-aware/naive inputs must never raise — they did once."""
        pd = pytest.importorskip("pandas")
        c = CostModel()
        aware = pd.Timestamp("2024-03-04 10:00", tz="UTC")
        later = pd.Timestamp("2024-03-07 10:00", tz="UTC")
        assert c.nights_held(aware, later) == 3
        assert c.swap_charge("BUY", 0.1, aware, later) != 0.0

    def test_accepts_strings(self):
        c = CostModel()
        assert c.nights_held("2024-03-04 10:00", "2024-03-07 10:00") == 3

    def test_none_is_tolerated(self):
        c = CostModel()
        assert c.nights_held(None, THU) == 0
        assert c.swap_charge("BUY", 1.0, None, None) == 0.0


def test_swap_table_covers_the_default_pairs():
    for pair in ("EUR/USD", "GBP/USD", "USD/JPY"):
        assert pair in DEFAULT_SWAP_TABLE
        assert "long" in DEFAULT_SWAP_TABLE[pair]
