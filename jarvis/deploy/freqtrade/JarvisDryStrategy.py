# Minimal dry-run strategy so the hosted Freqtrade has live positions to show
# in the Jarvis dashboard. Plain RSI mean-reversion — NOT trading advice, just a
# working example that exercises the engine and the REST API.
from pandas import DataFrame
import talib.abstract as ta
from freqtrade.strategy import IStrategy


class JarvisDryStrategy(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "5m"
    can_short = False

    minimal_roi = {"0": 0.05, "60": 0.02, "120": 0.0}
    stoploss = -0.10
    startup_candle_count = 30

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[dataframe["rsi"] < 30, "enter_long"] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[dataframe["rsi"] > 70, "exit_long"] = 1
        return dataframe
