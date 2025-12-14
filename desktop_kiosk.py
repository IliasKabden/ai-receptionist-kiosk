import webview

def main():
    webview.create_window(
        title="AI Receptionist Kiosk",
        url="http://localhost:5500/kiosk.html",
        fullscreen=True,
    )
    webview.start()

if __name__ == "__main__":
    main()
