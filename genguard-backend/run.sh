#!/bin/bash
# GenGuard Backend - Start Script

echo "🛡️ GenGuard Backend"
echo "==================="

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install dependencies
echo "Installing dependencies..."
pip install -r requirements.txt --quiet

# Start server
echo ""
echo "Starting GenGuard API server..."
echo "Server: http://localhost:5000"
echo "Docs:   http://localhost:5000/docs"
echo ""
python main.py
