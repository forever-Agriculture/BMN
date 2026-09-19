# Voice dictation

Talk instead of typing, in any session: a shell, Claude Code, Codex or anything else. The recording
is transcribed on your own CPU by [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and the
text is pasted into the session without pressing Enter, so you can review it first.

No audio or text leaves the computer, and transcription costs nothing per use.

## Using it

- **Hold Space** in a terminal. Recording starts after 0.3 seconds and stops when you release the
  key. A quick tap still types a space, and typing another key before releasing types the space
  first, so normal typing is unaffected.
- Or press **Speak** in the pane footer, or `Ctrl+Shift+Space`, to start and stop recording.

Hold Space is on by default. Turn it off in **Preferences → Voice → Hold Space to talk** if you use
programs that need a held Space.

## Setup

1. Build the engine once: `pnpm run voice:build` (`pnpm run package` does it for you). It
   downloads whisper.cpp 1.9.4, checks the pinned SHA-256, applies one small patch (below) and
   builds `whisper-cli` and whisper.cpp's speech detector (`whisper-vad-speech-segments`) into
   `apps/desktop/resources/whisper/`, next to the Silero speech model from the same archive (also
   pinned by SHA-256). It needs `cmake`; if `cmake` is not installed it uses a pinned CMake through
   [uv](https://docs.astral.sh/uv/).
2. Open **Preferences → Voice** and download a model. Download also selects it.

| Model | Download | Notes |
| --- | --- | --- |
| Base | 148 MB | Faster, less accurate |
| Small | 488 MB | Recommended for mixed or non-English speech |

Both are the multilingual models from
[`ggerganov/whisper.cpp`](https://huggingface.co/ggerganov/whisper.cpp) on Hugging Face. A download
is written to a partial file, checked against its pinned size and SHA-256, and only then moved into
place. Models are stored in `~/.local/share/bmn/voice/models/` unless you choose another
**Model folder**. A chosen folder that is missing, for example on an unmounted disk, is reported and
never created.

If the chosen model is not installed but another one is, Speak uses the installed one and saves it
as your choice.

Languages: Detect automatically, English, Ukrainian, Russian, Polish, German, French, Spanish,
Italian and Portuguese. Choosing your language skips detection and is slightly faster.

## Vocabulary

Whisper often mishears project names and identifiers. **Preferences → Voice → Vocabulary** holds
words it should expect: press **Suggest from current session** to see names from the session you
are working in (its workspace and session names, its directory, and file names and identifiers in
its last 120 terminal rows), edit a suggestion if needed and approve it, or type a word under
**Add word**. Remove a word at any time. Nothing is stored until you approve it.

On every recording the approved words are joined with `, ` and passed to `whisper-cli` as its
initial prompt (`--prompt`), exactly as the panel's "Sent to Whisper" line shows. This is a hint,
not a rule: Whisper may still miss a word, and the benefit depends on your voice and microphone.
Edits apply to the next recording. The list holds at most 30 words and 223 bytes in total (UTF-8:
Latin letters take one byte, Cyrillic letters two). whisper.cpp keeps at most 223 prompt tokens and
never makes more than one token from a byte, so every word always reaches Whisper, whatever the
script; the panel refuses further words instead of cutting the list.

The approved words are visible to local process inspection (for example `ps`) while `whisper-cli`
runs. They never appear in BMN's logs or error messages.

## Silence

Whisper invents text for a recording without speech (often "you"), and with approved words it
tends to repeat them instead. So BMN first checks the recording with the Silero speech model and
sends it to Whisper only if some moment reaches a speech probability of 0.3, with no minimum length,
so one short word said alone still counts. Otherwise nothing is pasted and BMN says "No speech was
recognized." The check takes a few tens of milliseconds. Measured with the bundled model on English
and synthetic Ukrainian speech: words and phrases peaked at 0.35–1.00 (the lowest was a short word
30 dB quieter in noise), silence and faint noise at 0.023 or less. The threshold sits below Silero's
default of 0.5 because a refused recording loses what you said, while noise that passes only gets
Whisper's usual transcription.

## Speed

Whisper normally encodes a fixed 30-second window, however short the recording. BMN passes
the recording's real length (`-ac`), and the build patches whisper.cpp so that automatic language
detection also encodes only the recording (upstream applies the shorter window only after
detection). Decoding is greedy (`-bs 1 -bo 1`) and uses half the CPU threads, at most 8.

Measured on a 6-core laptop CPU (AMD Ryzen 5 4600H) with Small, for a 3-second phrase:

| Setting | Before | Now |
| --- | --- | --- |
| Detect automatically | about 6.0 s | about 1.45 s |
| Language chosen | | about 1.0 s |

Base is faster than Small. Longer recordings take proportionally longer.

## Privacy

- The microphone is opened only while recording.
- The audio is written as a WAV file into a new private temporary folder, transcribed, and the
  folder is deleted afterwards.
- The speech detector and `whisper-cli` run as local programs on that file. The only network use is the model download
  you start.

## Troubleshooting

- **Speak opens Preferences.** No model is installed yet, or the voice engine was not built. Run
  `pnpm run voice:build` and download a model.
- **"No speech was recognized" although you spoke.** The speech check heard nothing that sounds like
  speech; speak closer to the microphone or check the input device.
- **Transcription is slow.** Use Base, or choose your language instead of Detect automatically.
- **Hold Space does nothing.** Check that the terminal has focus and that Hold Space to talk is on.
