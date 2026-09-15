# Afterhours — your private remix studio

## Open it

Double-click **Start Afterhours.command** in this folder. Keep the Terminal window it opens running while you use the studio.

Open **http://127.0.0.1:8769** in your browser. If the app is already running, the launcher opens that same session. No internet, account, paid service or cloud upload is required.

Your track **Voyager Folk** and **The one you liked** are already in the library.

## Make a remix

1. Choose an existing track or click **Add a track**. Drag and drop also works.
2. Pick **Broken beat**, **Minimal techno**, or **Half-time**.
3. Adjust the amount of change, drum activity, melody level, breakdown and length.
4. Click **Make a remix**. Each click creates a new variation; existing versions stay saved.
5. Listen, jump between sections, favourite versions and download WAV or MP3.

Try **Broken beat**, the default settings, and **Standard** length first. For a more regular dance pulse, try **Minimal techno**. Each generation uses a different variation seed, so it will not be identical to the approved example.

The **Match listening volume** option makes comparisons fairer. The tempo correction is optional; use it only if the new beat seems out of step. It corrects the source beat grid, not playback speed.

Supported uploads: WAV, MP3, FLAC, M4A, AIFF and OGG; 30 seconds to 10 minutes, up to 200 MB. Original uploads are preserved. WAV output is 24-bit; MP3 output is 320 kbps. Exporting an MP3 source to WAV does not restore detail missing from the original.

## Mix the sections live

Wait for the selected remix to load, then press **Play**. Click **New groove**, **Build**, **Breakdown**, or another section while it is playing. The selected section turns amber and is queued for the next beat; the current section keeps playing until the switch. The green highlight follows the section that is playing.

- Click another section before the switch to replace the queued choice.
- **Cancel** removes the queued jump. **Pause** clears it too.
- While paused, clicking a section starts directly at that section.
- **Jump to the return** uses the same beat-synchronised switching.
- The waveform is still a manual scrubber; using it clears a queued jump.
- The beat grid uses the saved remix's BPM, including any source-tempo correction used to create that remix.

The player decodes the local WAV before playback and schedules transitions with the audio clock, with a brief crossfade to soften cut boundaries. A click within the audio scheduling safety margin may use the following beat. This keeps audio timing independent of screen refreshes.

Live mixing currently affects playback only. WAV/MP3 downloads contain the saved generated arrangement; this version does not record a live performance.

## What this version does

It extracts two phrases from a finished track, approximately separates sustained and rhythmic sounds, chops and rearranges phrases, programs new drums, and creates an opening, groove, breakdown, build, return and outro. The recipe comes from the structural remix you approved.

It is a source-based remix engine with explicit musical rules. It does not use a generative AI music service, clean individual instrument stems or recordings from the reference artist. Some tracks will work better than others, particularly when the original timing varies.

## Save, stop and resume

- Your library, uploads, settings for each remix, favourites and rendered audio are stored in **studio-data/** inside this folder.
- Copy the whole **Afterhours Remix Studio** folder, including **studio-data**, to back up the app and your music together.
- Closing the browser does not stop a render. Closing the app's Terminal window or putting the Mac to sleep may interrupt it.
- To stop the server, press **Control-C** in its Terminal window. Run the launcher again to restart.
- If a render was interrupted, the library marks it as unfinished; select the track and make a new version. Completed versions remain available.
- The app is accessible only on this Mac, not from other devices on your Wi-Fi.

This Mac already has the required Python/NumPy and FFmpeg. Moving the app to a different Mac would require those dependencies there too.

## Verification and remaining check

The integration test used a separate temporary library. It successfully uploaded Voyager Folk, estimated its tempo near 136 BPM, rendered a new minimal-techno short version, checked its MP3 peaks, exercised audio seeking and WAV/MP3 downloads, saved a favourite and reopened it after restarting the server. Invalid settings, unsupported file extensions, unauthorized writes and non-local requests were also checked.

The live player was subsequently checked in the browser with saved remixes: WAV loading, starting a section, a visible queued Build, playback moving to that part of the arrangement, pausing, and the live controls' layout. No console warnings or errors were reported during that check. Fourteen focused playback tests cover beat scheduling, crossfade gain, delayed UI updates, replacement/cancellation of cues, seeking, pausing, changing tracks, end-of-track transitions and failed loads. Run them with `node --test test_beat_player.cjs`. Browser file-picker interactions have not been rechecked as part of this playback change.

## Continue next session

Open this folder and this file. Continue listening and refining the controls/recipe from your feedback. Musical flow matters more than extending the track. Keep all existing music and versions.

Implementation: **server.py** serves the app locally; **engine.py** renders remixes using **audio_core.py**; **web/** holds the interface. **test_studio.py** runs the isolated end-to-end test.
