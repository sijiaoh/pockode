import { useState } from "react";
import TokenInput from "./components/Auth/TokenInput";
import { ChatPanel } from "./components/Chat";
import { wsStore } from "./lib/wsStore";
import { clearToken, getToken, saveToken } from "./utils/config";

function App() {
	const [hasToken, setHasToken] = useState(() => !!getToken());

	const handleTokenSubmit = (token: string) => {
		saveToken(token);
		setHasToken(true);
	};

	const handleLogout = () => {
		wsStore.disconnect();
		clearToken();
		setHasToken(false);
	};

	if (!hasToken) {
		return <TokenInput onSubmit={handleTokenSubmit} />;
	}

	return <ChatPanel onLogout={handleLogout} />;
}

export default App;
