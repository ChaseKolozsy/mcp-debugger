#!/usr/bin/env python3
"""
Example Python script to test the line validation tool.
This script has various types of lines to test the validator:
- Import statements
- Function definitions
- Method calls
- Control flow
- Assignments
- Function calls
"""

import math
import random
from datetime import datetime


def calculate_area(radius):
    """Calculate the area of a circle."""
    # This is a comment line that should be skipped
    area = math.pi * radius ** 2
    return area


def fibonacci(n):
    """Calculate fibonacci number recursively."""
    if n <= 0:
        return 0
    elif n == 1:
        return 1
    else:
        # Recursive call - validator should step into this
        return fibonacci(n - 1) + fibonacci(n - 2)


class Calculator:
    """Simple calculator class for testing method validation."""
    
    def __init__(self):
        self.history = []
    
    def add(self, a, b):
        """Add two numbers."""
        result = a + b
        self.history.append(f"Added {a} + {b} = {result}")
        return result
    
    def multiply(self, a, b):
        """Multiply two numbers."""
        result = a * b
        self.history.append(f"Multiplied {a} * {b} = {result}")
        return result
    
    def get_history(self):
        """Get calculation history."""
        return self.history.copy()


def main():
    """Main function to test various code patterns."""
    print("Starting validation test script...")
    
    # Test simple function call
    radius = 5
    area = calculate_area(radius)
    print(f"Area of circle with radius {radius}: {area}")
    
    # Test recursive function
    fib_num = 6
    fib_result = fibonacci(fib_num)
    print(f"Fibonacci({fib_num}) = {fib_result}")
    
    # Test class and methods
    calc = Calculator()
    
    # Test method calls
    sum_result = calc.add(10, 20)
    product_result = calc.multiply(5, 7)
    
    # Test control flow
    numbers = [1, 2, 3, 4, 5]
    total = 0
    for num in numbers:
        total += num
    
    # Test conditional
    if total > 10:
        print(f"Total {total} is greater than 10")
    else:
        print(f"Total {total} is not greater than 10")
    
    # Test list comprehension
    squared = [x ** 2 for x in numbers]
    print(f"Squared numbers: {squared}")
    
    # Test exception handling
    try:
        result = 10 / 0
    except ZeroDivisionError:
        print("Caught division by zero")
    
    # Test with statement
    current_time = datetime.now()
    print(f"Script completed at {current_time}")
    
    # Get calculator history
    history = calc.get_history()
    print("Calculator history:")
    for entry in history:
        print(f"  - {entry}")


if __name__ == "__main__":
    main()