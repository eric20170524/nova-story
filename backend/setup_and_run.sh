#!/bin/bash
cd "$(dirname "$0")"

# Check if python3 is installed
if ! command -v python3 &> /dev/null
then
    echo "Python 3 is not installed. Please install Python 3.10+ and try again."
    exit 1
fi

# Create virtual environment if it doesn't exist
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
fi

# Activate virtual environment
source .venv/bin/activate

# Upgrade pip
echo "Upgrading pip..."
pip install --upgrade pip

# Install dependencies
if [ -f "requirements.txt" ]; then
    echo "Installing dependencies..."
    pip install -r requirements.txt
else
    echo "requirements.txt not found! Skipping dependency installation."
fi

# Run database migrations
if [ -f "alembic.ini" ]; then
    echo "Running database migrations..."
    alembic upgrade head
fi

# Start the server
echo "Starting NovaStory Backend..."
python main.py
