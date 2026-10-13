"""cloudplace — latency-aware cloud task & replica placement on network graphs."""
from .core import Graph
from .model import Instance, Service, BatchTask
from .solver import SolveConfig, solve

__version__ = "1.0.0"
