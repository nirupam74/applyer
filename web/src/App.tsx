import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireAuth } from './auth'
import Answers from './pages/Answers'
import ApplicationDetail from './pages/ApplicationDetail'
import Applications from './pages/Applications'
import ForgotPassword from './pages/ForgotPassword'
import Home from './pages/Home'
import JobDetail from './pages/JobDetail'
import Jobs from './pages/Jobs'
import Login from './pages/Login'
import Profile from './pages/Profile'
import Resume from './pages/Resume'
import Shell from './pages/Shell'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/home" replace />} />
        <Route path="home" element={<Home />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="jobs/:id" element={<JobDetail />} />
        <Route path="applications" element={<Applications />} />
        <Route path="applications/:id" element={<ApplicationDetail />} />
        <Route path="resume" element={<Resume />} />
        <Route path="answers" element={<Answers />} />
        <Route path="profile" element={<Profile />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
