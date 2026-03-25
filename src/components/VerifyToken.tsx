import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { verifyToken } from "../lib/auth";

export function VerifyToken() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setError(t("verifyToken.missingToken")); // eslint-disable-line react-hooks/set-state-in-effect -- error on mount is intentional
      return;
    }

    verifyToken(token)
      .then(() => {
        navigate("/", { replace: true });
      })
      .catch((err) => setError(String(err)));
  }, [searchParams, navigate, t]);

  return (
    <div className="min-h-dvh bg-surface-primary text-text-primary flex items-center justify-center">
      <div className="text-center">
        {error ? (
          <div>
            <p className="text-red-400 mb-2">{error}</p>
            <a href="/login" className="text-blue-400 hover:underline">
              {t("verifyToken.backToLogin")}
            </a>
          </div>
        ) : (
          <p className="text-text-tertiary">{t("verifyToken.verifying")}</p>
        )}
      </div>
    </div>
  );
}
