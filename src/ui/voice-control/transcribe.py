#!/usr/bin/env python3
"""
Whisper transcription wrapper for Aegis Voice Control.
Uses faster-whisper or whisper.cpp to transcribe audio files.
"""

import json
import sys
import os
from pathlib import Path

def transcribe_with_whisper_cpp(audio_path: str, model_path: str) -> dict:
    """Transcribe using whisper.cpp binary."""
    import subprocess
    import shutil
    
    whisper_bin = shutil.which('whisper')
    if not whisper_bin:
        return {"success": False, "error": "whisper binary not found in PATH"}
    
    if not os.path.exists(model_path):
        return {"success": False, "error": f"Model not found: {model_path}"}
    
    try:
        result = subprocess.run(
            [whisper_bin, '-m', model_path, '-f', audio_path, '-otxt', '-ot'],
            capture_output=True,
            text=True,
            timeout=60
        )
        
        output = result.stdout.strip()
        lines = output.split('\n')
        
        # Extract text from whisper output (last line should be the transcription)
        if lines:
            # Whisper formats output as: "timestamp text"
            text_parts = lines[-1].split('\t', 1)
            if len(text_parts) > 1:
                text = text_parts[1].strip()
            else:
                text = output.strip()
            
            return {"success": True, "text": text, "raw": output}
        else:
            return {"success": False, "error": "No output from whisper"}
            
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Transcription timeout"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def transcribe_with_python_whisper(audio_path: str, model: str = "base") -> dict:
    """Transcribe using Python whisper library."""
    try:
        import whisper
    except ImportError:
        return {"success": False, "error": "Python whisper not installed"}
    
    try:
        model = whisper.load_model(model)
        result = model.transcribe(audio_path)
        return {"success": True, "text": result["text"].strip(), "language": result.get("language", "unknown")}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: transcribe.py <audio_file> [model]"}))
        sys.exit(1)
    
    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
    
    if not os.path.exists(audio_path):
        print(json.dumps({"success": False, "error": f"Audio file not found: {audio_path}"}))
        sys.exit(1)
    
    # Determine model path
    model_path = Path.home() / ".cache" / "whisper" / "ggml-base.bin"
    
    # Try whisper.cpp first
    result = transcribe_with_whisper_cpp(audio_path, str(model_path))
    if result["success"]:
        print(json.dumps(result))
        sys.exit(0)
    
    # Fallback to Python whisper
    result = transcribe_with_python_whisper(audio_path, model_name)
    print(json.dumps(result))
    sys.exit(0 if result["success"] else 1)

if __name__ == "__main__":
    main()