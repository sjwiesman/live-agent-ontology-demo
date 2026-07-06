import ChatWidget from './components/ChatWidget';
import { ChatProvider } from './contexts/ChatContext';
import DashboardPage from './pages/DashboardPage';

export default function App() {
  return (
    <ChatProvider>
      <DashboardPage />
      <ChatWidget />
    </ChatProvider>
  );
}
