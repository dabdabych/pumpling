from dataclasses import dataclass


@dataclass
class CounterUpdatedEvent:
    counter: int
